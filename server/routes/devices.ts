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

// List Devices (redact sensitive info)
router.get('/', (req, res) => {
  const devices = db.prepare('SELECT id, name, host, username, port, sync_when_connected, last_connected_at, created_at FROM devices').all();
  res.json(devices);
});

// Create Device
router.post('/', async (req, res) => {
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const name = requireString(req.body.name, 'name');
    const host = requireString(req.body.host, 'host');
    const username = requireString(req.body.username, 'username');
    const password = optionalString(req.body.password, 'password');
    const sync_when_connected = optionalBoolean(req.body.sync_when_connected, 'sync_when_connected') || false;
    const port = optionalInteger(req.body.port, 'port', 1, 65535) || 22;
    const id = uuidv4();

    // Validate connection first
    const testService = new SSHService({
        host,
        username,
        port,
        password
    });

    // Test connection
    try {
        await testService.testConnection(); 
    } catch (connErr: any) {
        return res.status(400).json({ error: `Connection failed: ${connErr.message}` });
    }

    const encrypted_password = password ? encrypt(password) : null;
    
    const stmt = db.prepare(`
      INSERT INTO devices (id, name, host, username, encrypted_password, port, sync_when_connected, last_connected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, name, host, username, encrypted_password, port, sync_when_connected ? 1 : 0, new Date().toISOString(), new Date().toISOString());
    
    res.json({ id, message: 'Device created and verified' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Update Device
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const name = requireString(req.body.name, 'name');
    const host = requireString(req.body.host, 'host');
    const username = requireString(req.body.username, 'username');
    const password = optionalString(req.body.password, 'password');
    const sync_when_connected = optionalBoolean(req.body.sync_when_connected, 'sync_when_connected') || false;
    const port = optionalInteger(req.body.port, 'port', 1, 65535) || 22;

    let passwordToTest = password;
    let encrypted_password = null;

    if (!password) {
        const existing = db.prepare('SELECT encrypted_password FROM devices WHERE id = ?').get(id) as any;
        if (existing && existing.encrypted_password) {
            passwordToTest = decrypt(existing.encrypted_password);
            encrypted_password = existing.encrypted_password; // Keep existing
        }
    } else {
        encrypted_password = encrypt(password);
    }

    const testService = new SSHService({
        host,
        username,
        port,
        password: passwordToTest
    });

    try {
        await testService.testConnection(); 
    } catch (connErr: any) {
        return res.status(400).json({ error: `Connection failed: ${connErr.message}` });
    }

    db.prepare(`
      UPDATE devices 
      SET name = ?, host = ?, username = ?, encrypted_password = ?, port = ?, sync_when_connected = ?, last_connected_at = ?
      WHERE id = ?
    `).run(name, host, username, encrypted_password, port, sync_when_connected ? 1 : 0, new Date().toISOString(), id);
    
    res.json({ message: 'Device updated and verified' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Delete Device
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    // Check if used by any document
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

// Test Connection Endpoint (Optional, if UI wants to test without saving)
router.post('/test', async (req, res) => {
    try {
        if (!isObject(req.body)) {
          throw new ValidationError('Request body must be a JSON object');
        }

        const host = requireString(req.body.host, 'host');
        const username = requireString(req.body.username, 'username');
        const password = optionalString(req.body.password, 'password');
        const port = optionalInteger(req.body.port, 'port', 1, 65535) || 22;

        const testService = new SSHService({
            host,
            username,
            password,
            port,
        });
        await testService.testConnection();
        res.json({ message: 'Connection successful' });
    } catch (err: any) {
        const error = getErrorMessage(err);
        res.status(error.status === 500 ? 400 : error.status).json({ error: error.message });
    }
});

// Check Connection for a specific device (by ID)
router.post('/:id/check', async (req, res) => {
    const { id } = req.params;
    try {
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
        if (!device) return res.status(404).json({ error: 'Device not found' });

        const sshConfig = {
            host: device.host,
            username: device.username,
            port: device.port,
            password: device.encrypted_password ? decrypt(device.encrypted_password) : undefined
        };

        const service = new SSHService(sshConfig);
        await service.testConnection();
        
        // Update last connected time
        db.prepare('UPDATE devices SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        
        res.json({ status: 'connected', message: 'Connection successful' });
    } catch (err: any) {
        res.status(500).json({ status: 'disconnected', error: err.message });
    }
});

export default router;
