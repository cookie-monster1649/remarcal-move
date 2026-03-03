import express from 'express';
import db from '../db.js';
import { encrypt, decrypt } from '../services/encryptionService.js';
import { SSHService } from '../services/sshService.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getErrorMessage,
  isObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireString,
  ValidationError,
} from '../utils/validation.js';

const router = express.Router();

function toPublicDeviceRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    username: row.username,
    port: row.port,
    sync_when_connected: row.sync_when_connected,
    last_connected_at: row.last_connected_at,
    created_at: row.created_at,
    auth_mode: row.auth_mode || 'password',
    host_key_fingerprint: row.host_key_fingerprint || null,
    allow_password_fallback: row.allow_password_fallback ? 1 : 0,
  };
}

function buildSshConfigFromDevice(device: any, override?: { password?: string; privateKey?: string }) {
  const authMode = device.auth_mode || 'password';
  const decryptedPrivateKey = override?.privateKey ?? (device.encrypted_private_key ? decrypt(device.encrypted_private_key) : undefined);
  const decryptedPassword = override?.password ?? (device.encrypted_password ? decrypt(device.encrypted_password) : undefined);

  return {
    host: device.host,
    username: device.username,
    port: device.port,
    hostKeyFingerprint: device.host_key_fingerprint || undefined,
    trustOnFirstUse: !device.host_key_fingerprint,
    privateKey: authMode === 'key' ? decryptedPrivateKey : undefined,
    password:
      authMode === 'password'
        ? decryptedPassword
        : device.allow_password_fallback
          ? decryptedPassword
          : undefined,
  };
}

router.get('/', (_req, res) => {
  const devices = db.prepare('SELECT * FROM devices').all();
  res.json(devices.map(toPublicDeviceRow));
});

router.post('/', async (req, res) => {
  try {
    if (!isObject(req.body)) throw new ValidationError('Request body must be a JSON object');

    const name = requireString(req.body.name, 'name');
    const host = requireString(req.body.host, 'host');
    const username = requireString(req.body.username, 'username');
    const password = optionalString(req.body.password, 'password');
    const sync_when_connected = optionalBoolean(req.body.sync_when_connected, 'sync_when_connected') || false;
    const port = optionalInteger(req.body.port, 'port', 1, 65535) || 22;
    const allow_password_fallback = optionalBoolean(req.body.allow_password_fallback, 'allow_password_fallback');

    if (!password) {
      return res.status(400).json({ error: 'password is required when creating a device' });
    }

    const testService = new SSHService({ host, username, port, password, trustOnFirstUse: true });
    await testService.testConnection();
    const observedFingerprint = testService.getObservedHostKeyFingerprint();
    if (!observedFingerprint) {
      throw new Error('Unable to obtain SSH host key fingerprint');
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO devices (
        id, name, host, username, encrypted_password, auth_mode,
        host_key_fingerprint, allow_password_fallback,
        port, sync_when_connected, last_connected_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      host,
      username,
      encrypt(password),
      observedFingerprint,
      allow_password_fallback === false ? 0 : 1,
      port,
      sync_when_connected ? 1 : 0,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    res.json({ id, message: 'Device created and verified', host_key_fingerprint: observedFingerprint });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (!isObject(req.body)) throw new ValidationError('Request body must be a JSON object');

    const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    const name = requireString(req.body.name, 'name');
    const host = requireString(req.body.host, 'host');
    const username = requireString(req.body.username, 'username');
    const port = optionalInteger(req.body.port, 'port', 1, 65535) || 22;
    const sync_when_connected = optionalBoolean(req.body.sync_when_connected, 'sync_when_connected') || false;
    const password = optionalString(req.body.password, 'password');
    const allow_password_fallback = optionalBoolean(req.body.allow_password_fallback, 'allow_password_fallback');

    const passwordToUse = password ?? (existing.encrypted_password ? decrypt(existing.encrypted_password) : undefined);
    if (!passwordToUse && !existing.encrypted_private_key) {
      return res.status(400).json({ error: 'No valid authentication available for connection test' });
    }

    const provisional = {
      ...existing,
      host,
      username,
      port,
      encrypted_password: password ? encrypt(password) : existing.encrypted_password,
      allow_password_fallback: allow_password_fallback === undefined ? existing.allow_password_fallback : (allow_password_fallback ? 1 : 0),
    };

    const testService = new SSHService(
      buildSshConfigFromDevice(provisional, {
        password: passwordToUse,
      })
    );
    await testService.testConnection();

    let nextFingerprint = existing.host_key_fingerprint;
    if (!nextFingerprint) {
      nextFingerprint = testService.getObservedHostKeyFingerprint();
    }

    db.prepare(`
      UPDATE devices
      SET name = ?, host = ?, username = ?, encrypted_password = ?,
          port = ?, sync_when_connected = ?, allow_password_fallback = ?,
          host_key_fingerprint = ?, last_connected_at = ?
      WHERE id = ?
    `).run(
      name,
      host,
      username,
      password ? encrypt(password) : existing.encrypted_password,
      port,
      sync_when_connected ? 1 : 0,
      allow_password_fallback === undefined ? existing.allow_password_fallback : (allow_password_fallback ? 1 : 0),
      nextFingerprint,
      new Date().toISOString(),
      id,
    );

    res.json({ message: 'Device updated and verified' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    const usage = db.prepare('SELECT count(*) as count FROM documents WHERE device_id = ?').get(id) as any;
    if (usage.count > 0) {
      return res.status(400).json({ error: 'Cannot delete device used by documents' });
    }
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    res.json({ message: 'Device deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    if (!isObject(req.body)) throw new ValidationError('Request body must be a JSON object');
    const host = requireString(req.body.host, 'host');
    const username = requireString(req.body.username, 'username');
    const password = optionalString(req.body.password, 'password');
    const port = optionalInteger(req.body.port, 'port', 1, 65535) || 22;
    const host_key_fingerprint = optionalString(req.body.host_key_fingerprint, 'host_key_fingerprint');

    const service = new SSHService({
      host,
      username,
      password,
      port,
      hostKeyFingerprint: host_key_fingerprint,
      trustOnFirstUse: !host_key_fingerprint,
    });
    await service.testConnection();

    res.json({
      message: 'Connection successful',
      host_key_fingerprint: service.getObservedHostKeyFingerprint(),
    });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status === 500 ? 400 : error.status).json({ error: error.message });
  }
});

router.post('/:id/check', async (req, res) => {
  const { id } = req.params;
  try {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const service = new SSHService(buildSshConfigFromDevice(device));
    await service.testConnection();

    db.prepare('UPDATE devices SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    res.json({
      status: 'connected',
      message: 'Connection successful',
      host_key_fingerprint: service.getObservedHostKeyFingerprint() || device.host_key_fingerprint,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'disconnected', error: err.message });
  }
});

router.post('/:id/enroll-key', async (req, res) => {
  const { id } = req.params;
  try {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const fallbackPassword = device.encrypted_password ? decrypt(device.encrypted_password) : undefined;
    if (!fallbackPassword) {
      return res.status(400).json({ error: 'Password is required before key enrollment' });
    }

    const keyPair = SSHService.generateKeyPair(`remarcal-${id}`);

    const bootstrap = new SSHService({
      host: device.host,
      username: device.username,
      port: device.port,
      password: fallbackPassword,
      hostKeyFingerprint: device.host_key_fingerprint || undefined,
      trustOnFirstUse: !device.host_key_fingerprint,
    });
    await bootstrap.installPublicKey(keyPair.publicKey);

    const verify = new SSHService({
      host: device.host,
      username: device.username,
      port: device.port,
      privateKey: keyPair.privateKey,
      hostKeyFingerprint: device.host_key_fingerprint || bootstrap.getObservedHostKeyFingerprint() || undefined,
      trustOnFirstUse: !device.host_key_fingerprint,
    });
    await verify.testConnection();

    const pinnedFingerprint = device.host_key_fingerprint || bootstrap.getObservedHostKeyFingerprint() || verify.getObservedHostKeyFingerprint();

    db.prepare(`
      UPDATE devices
      SET auth_mode = 'key',
          encrypted_private_key = ?,
          public_key = ?,
          host_key_fingerprint = ?,
          allow_password_fallback = ?
      WHERE id = ?
    `).run(
      encrypt(keyPair.privateKey),
      keyPair.publicKey,
      pinnedFingerprint,
      device.allow_password_fallback ? 1 : 0,
      id,
    );

    res.json({
      message: 'Key authentication enrolled successfully',
      host_key_fingerprint: pinnedFingerprint,
    });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

router.post('/:id/auth-mode', (req, res) => {
  const { id } = req.params;
  try {
    if (!isObject(req.body)) throw new ValidationError('Request body must be a JSON object');
    const mode = requireString(req.body.auth_mode, 'auth_mode');
    if (mode !== 'password' && mode !== 'key') {
      throw new ValidationError('auth_mode must be "password" or "key"');
    }
    const allowPasswordFallback = optionalBoolean(req.body.allow_password_fallback, 'allow_password_fallback');

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (mode === 'key' && !device.encrypted_private_key) {
      return res.status(400).json({ error: 'Device has no enrolled key' });
    }

    db.prepare('UPDATE devices SET auth_mode = ?, allow_password_fallback = ? WHERE id = ?').run(
      mode,
      allowPasswordFallback === undefined ? device.allow_password_fallback : (allowPasswordFallback ? 1 : 0),
      id,
    );

    res.json({ message: 'Authentication mode updated' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

export default router;
