import express from 'express';
import db from '../db.js';
import { SyncService } from '../services/syncService.js';
import { schedulerService } from '../services/schedulerService.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const syncService = new SyncService();

// List Documents
router.get('/', (req, res) => {
  const docs = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all();
  res.json(docs);
});

// Create Document
router.post('/', (req, res) => {
  const { title, type, remote_path, sync_enabled, sync_schedule, caldav_account_id, device_id, year, timezone } = req.body;
  const id = uuidv4();
  
  try {
    db.prepare(`
      INSERT INTO documents (id, title, type, remote_path, sync_enabled, sync_schedule, caldav_account_id, device_id, year, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, type || 'pdf', remote_path, sync_enabled ? 1 : 0, sync_schedule, caldav_account_id, device_id, year || new Date().getFullYear(), timezone || 'UTC');
    
    if (sync_enabled && sync_schedule) {
      schedulerService.scheduleJob(id, sync_schedule);
    }
    
    res.json({ id, message: 'Document created' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update Document
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { title, remote_path, sync_enabled, sync_schedule, caldav_account_id, device_id, year, timezone } = req.body;
  
  try {
    db.prepare(`
      UPDATE documents 
      SET title = ?, remote_path = ?, sync_enabled = ?, sync_schedule = ?, caldav_account_id = ?, device_id = ?, year = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(title, remote_path, sync_enabled ? 1 : 0, sync_schedule, caldav_account_id, device_id, year, timezone || 'UTC', id);
    
    if (sync_enabled && sync_schedule) {
      schedulerService.scheduleJob(id, sync_schedule);
    } else {
      schedulerService.cancelJob(id);
    }
    
    res.json({ message: 'Document updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Document
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    schedulerService.cancelJob(id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    // Also delete local file if exists
    // fs.unlinkSync(path.join(process.env.DATA_DIR, 'docs', `${id}.pdf`));
    res.json({ message: 'Document deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Sync Now
router.post('/:id/sync', async (req, res) => {
  const { id } = req.params;
  try {
    await syncService.syncDocument(id);
    res.json({ message: 'Sync started' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
