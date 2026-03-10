import express from 'express';
import db from '../db.js';
import { backupService } from '../services/backupService.js';
import { infoLogService } from '../services/infoLogService.js';
import { getErrorMessage, optionalString } from '../utils/validation.js';

const router = express.Router();

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
