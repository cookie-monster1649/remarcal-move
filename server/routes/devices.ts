import express from 'express';
import db from '../db.js';
import { encrypt, decrypt } from '../services/encryptionService.js';
import { SSHService } from '../services/sshService.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// List Devices (redact sensitive info)
router.get('/', (req, res) => {
  const devices = db.prepare('SELECT id, name, host, username, port, last_connected_at, created_at FROM devices').all();
  res.json(devices);
});

// Create Device
router.post('/', async (req, res) => {
  const { name, host, username, password, port, private_key_path } = req.body;
  const id = uuidv4();
  
  try {
    // Validate connection first
    let privateKeyContent: string | undefined;
    if (private_key_path) {
        try {
            if (fs.existsSync(private_key_path)) {
                privateKeyContent = fs.readFileSync(private_key_path, 'utf8');
            } else {
                return res.status(400).json({ error: `Private key file not found at ${private_key_path}` });
            }
        } catch (e: any) {
            return res.status(400).json({ error: `Failed to read private key: ${e.message}` });
        }
    }

    const testService = new SSHService({
        host,
        username,
        port: parseInt(port || '22', 10),
        password,
        privateKey: privateKeyContent
    });

    // Test connection
    try {
        await testService.testConnection(); 
    } catch (connErr: any) {
        return res.status(400).json({ error: `Connection failed: ${connErr.message}` });
    }

    const encrypted_password = password ? encrypt(password) : null;
    
    const stmt = db.prepare(`
      INSERT INTO devices (id, name, host, username, encrypted_password, port, private_key_path, last_connected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, name, host, username, encrypted_password, port || 22, private_key_path, new Date().toISOString(), new Date().toISOString());
    
    res.json({ id, message: 'Device created and verified' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update Device
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, host, username, password, port, private_key_path } = req.body;
  
  try {
    // Validate connection first
    let privateKeyContent: string | undefined;
    if (private_key_path) {
        try {
            if (fs.existsSync(private_key_path)) {
                privateKeyContent = fs.readFileSync(private_key_path, 'utf8');
            } else {
                return res.status(400).json({ error: `Private key file not found at ${private_key_path}` });
            }
        } catch (e: any) {
            return res.status(400).json({ error: `Failed to read private key: ${e.message}` });
        }
    }
    
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
        port: parseInt(port || '22', 10),
        password: passwordToTest,
        privateKey: privateKeyContent
    });

    try {
        await testService.testConnection(); 
    } catch (connErr: any) {
        return res.status(400).json({ error: `Connection failed: ${connErr.message}` });
    }

    db.prepare(`
      UPDATE devices 
      SET name = ?, host = ?, username = ?, encrypted_password = ?, port = ?, private_key_path = ?, last_connected_at = ?
      WHERE id = ?
    `).run(name, host, username, encrypted_password, port || 22, private_key_path, new Date().toISOString(), id);
    
    res.json({ message: 'Device updated and verified' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    const { host, username, password, port } = req.body;
    try {
        const testService = new SSHService({
            host,
            username,
            password,
            // port not yet supported in SSHService config interface fully, need to update it
        });
        await testService.testConnection();
        res.json({ message: 'Connection successful' });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// Check Connection for a specific device (by ID)
router.post('/:id/check', async (req, res) => {
    const { id } = req.params;
    try {
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
        if (!device) return res.status(404).json({ error: 'Device not found' });

        let privateKeyContent: string | undefined;
        if (device.private_key_path) {
            try {
                if (fs.existsSync(device.private_key_path)) {
                    privateKeyContent = fs.readFileSync(device.private_key_path, 'utf8');
                }
            } catch (e) {
                console.warn(`Failed to read private key for device ${id}:`, e);
            }
        }

        const sshConfig = {
            host: device.host,
            username: device.username,
            port: device.port,
            password: device.encrypted_password ? decrypt(device.encrypted_password) : undefined,
            privateKey: privateKeyContent
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
