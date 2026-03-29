import express from 'express';
import { spawnSync } from 'child_process';
import db from '../db.js';
import { backupService } from '../services/backupService.js';
import { infoLogService } from '../services/infoLogService.js';
import { sshKeyManager } from '../services/sshKeyManager.js';
import { getErrorMessage, optionalString } from '../utils/validation.js';

const router = express.Router();

function hasRsyncBinary(): boolean {
  try {
    const out = spawnSync('rsync', ['--version'], { stdio: 'ignore' });
    return out.status === 0;
  } catch {
    return false;
  }
}

router.post('/device/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const out = await backupService.startDeviceBackup(id);
    if (out.queued) {
      return res.status(202).json({
        message: 'Backup queued',
      });
    }
    res.status(202).json({
      message: 'Backup started',
      backupId: out.backupId,
    });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

router.get('/', (req, res) => {
  try {
    const deviceId = optionalString(req.query.device_id, 'device_id');
    const limit = Number(req.query.limit || 100);

    const rows = deviceId
      ? db.prepare(`
          SELECT b.*, d.name AS device_name
          FROM device_backups b
          JOIN devices d ON d.id = b.device_id
          WHERE b.device_id = ?
          ORDER BY datetime(b.started_at) DESC
          LIMIT ?
        `).all(deviceId, Math.max(1, Math.min(limit, 500)))
      : db.prepare(`
          SELECT b.*, d.name AS device_name
          FROM device_backups b
          JOIN devices d ON d.id = b.device_id
          ORDER BY datetime(b.started_at) DESC
          LIMIT ?
        `).all(Math.max(1, Math.min(limit, 500)));

    res.json(rows);
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

router.get('/logs/recent', (req, res) => {
  try {
    const limit = Number(req.query.limit || 200);
    const rows = infoLogService.tail(Math.max(1, Math.min(limit, 1000)));
    return res.json(rows);
  } catch (err: any) {
    const error = getErrorMessage(err);
    return res.status(error.status).json({ error: error.message });
  }
});

router.get('/diagnostics', (_req, res) => {
  try {
    const rsyncAvailable = hasRsyncBinary();
    const devices = db.prepare(`
      SELECT id, name, auth_mode, allow_password_fallback, encrypted_password, encrypted_private_key
      FROM devices
      ORDER BY name COLLATE NOCASE ASC
    `).all() as any[];

    const diagnostics = devices.map((d) => {
      const hasFsPrivateKey = sshKeyManager.hasDevicePrivateKey(d.id);
      const hasDbPrivateKey = !!d.encrypted_private_key;
      const hasPassword = !!d.encrypted_password;
      const authMode = d.auth_mode || 'password';
      const effectiveAuth = authMode === 'key' && (hasFsPrivateKey || hasDbPrivateKey)
        ? 'key'
        : authMode === 'password' && hasPassword
          ? 'password'
          : 'invalid';

      const willUseRsync = rsyncAvailable && effectiveAuth === 'key';
      const expectedTransferMethod = willUseRsync ? 'rsync' : 'sftp';
      const reason = willUseRsync
        ? 'Key auth active and rsync binary available'
        : !rsyncAvailable
          ? 'rsync binary not available on server'
          : effectiveAuth !== 'key'
            ? `Device auth mode is ${authMode}`
            : 'Missing usable private key material';

      return {
        device_id: d.id,
        device_name: d.name,
        auth_mode: authMode,
        allow_password_fallback: !!d.allow_password_fallback,
        has_fs_private_key: hasFsPrivateKey,
        has_db_private_key: hasDbPrivateKey,
        has_password: hasPassword,
        effective_auth: effectiveAuth,
        rsync_binary_available: rsyncAvailable,
        will_use_rsync: willUseRsync,
        expected_transfer_method: expectedTransferMethod,
        reason,
      };
    });

    return res.json({
      generated_at: new Date().toISOString(),
      rsync_binary_available: rsyncAvailable,
      devices: diagnostics,
    });
  } catch (err: any) {
    const error = getErrorMessage(err);
    return res.status(error.status).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare(`
      SELECT b.*, d.name AS device_name
      FROM device_backups b
      JOIN devices d ON d.id = b.device_id
      WHERE b.id = ?
    `).get(id) as any;

    if (!row) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    return res.json(row);
  } catch (err: any) {
    const error = getErrorMessage(err);
    return res.status(error.status).json({ error: error.message });
  }
});

router.get('/:id/progress', (req, res) => {
  try {
    const { id } = req.params;
    const progress = backupService.getBackupProgress(id);
    if (!progress) {
      return res.status(404).json({ error: 'No live progress for this backup' });
    }
    return res.json(progress);
  } catch (err: any) {
    const error = getErrorMessage(err);
    return res.status(error.status).json({ error: error.message });
  }
});

router.post('/:id/cancel', (req, res) => {
  try {
    const { id } = req.params;
    backupService.cancelBackup(id);
    return res.json({ message: 'Cancel requested' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    return res.status(error.status).json({ error: error.message });
  }
});

export default router;
