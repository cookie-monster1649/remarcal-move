import express from 'express';
import db from '../db.js';
import { encrypt } from '../services/encryptionService.js';
import { CalDavService } from '../services/caldavService.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const caldavService = new CalDavService();

// List Accounts (redact password)
router.get('/', (req, res) => {
  const accounts = db.prepare('SELECT id, name, url, username, selected_calendars, created_at FROM caldav_accounts').all();
  res.json(accounts);
});

// Discover Calendars
router.post('/discover', async (req, res) => {
  const { url, username, password, accountId } = req.body;
  try {
    const calendars = await caldavService.discoverCalendars({ url, username, password, accountId });
    res.json(calendars);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create Account
router.post('/', (req, res) => {
  const { name, url, username, password, selected_calendars } = req.body;
  const id = uuidv4();
  
  try {
    const encrypted_password = encrypt(password);
    db.prepare(`
      INSERT INTO caldav_accounts (id, name, url, username, encrypted_password, selected_calendars)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, url, username, encrypted_password, JSON.stringify(selected_calendars || []));
    
    res.json({ id, message: 'Account created' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update Account
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, url, username, password, selected_calendars } = req.body;
  
  try {
    if (password) {
      const encrypted_password = encrypt(password);
      db.prepare(`
        UPDATE caldav_accounts 
        SET name = ?, url = ?, username = ?, encrypted_password = ?, selected_calendars = ?
        WHERE id = ?
      `).run(name, url, username, encrypted_password, JSON.stringify(selected_calendars || []), id);
    } else {
      db.prepare(`
        UPDATE caldav_accounts 
        SET name = ?, url = ?, username = ?, selected_calendars = ?
        WHERE id = ?
      `).run(name, url, username, JSON.stringify(selected_calendars || []), id);
    }
    
    res.json({ message: 'Account updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Account
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(id);
    res.json({ message: 'Account deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
