import express from 'express';
import db from '../db.js';
import { SyncService } from '../services/syncService.js';
import { schedulerService } from '../services/schedulerService.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const syncService = new SyncService();

// List Documents
router.get('/', (req, res) => {
  const docs = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all() as any[];
  
  // For each document, fetch its linked accounts
  const docsWithAccounts = docs.map(doc => {
    const accounts = db.prepare('SELECT account_id FROM document_accounts WHERE document_id = ?').all(doc.id) as any[];
    return {
      ...doc,
      caldav_account_ids: accounts.map(a => a.account_id)
    };
  });
  
  res.json(docsWithAccounts);
});

// Create Document
router.post('/', (req, res) => {
  const { title, type, remote_path, sync_enabled, sync_schedule, caldav_account_ids, device_id, year, timezone } = req.body;
  const id = uuidv4();
  
  try {
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO documents (id, title, type, remote_path, sync_enabled, sync_schedule, caldav_account_id, device_id, year, timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, type || 'pdf', remote_path, sync_enabled ? 1 : 0, sync_schedule, caldav_account_ids?.[0] || null, device_id, year || new Date().getFullYear(), timezone || 'UTC');

      if (Array.isArray(caldav_account_ids)) {
        const insertAccount = db.prepare('INSERT INTO document_accounts (document_id, account_id) VALUES (?, ?)');
        for (const accountId of caldav_account_ids) {
          insertAccount.run(id, accountId);
        }
      }
    });

    transaction();
    
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
  const { title, remote_path, sync_enabled, sync_schedule, caldav_account_ids, device_id, year, timezone } = req.body;
  
  try {
    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE documents 
        SET title = ?, remote_path = ?, sync_enabled = ?, sync_schedule = ?, caldav_account_id = ?, device_id = ?, year = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(title, remote_path, sync_enabled ? 1 : 0, sync_schedule, caldav_account_ids?.[0] || null, device_id, year, timezone || 'UTC', id);

      // Update linked accounts
      db.prepare('DELETE FROM document_accounts WHERE document_id = ?').run(id);
      if (Array.isArray(caldav_account_ids)) {
        const insertAccount = db.prepare('INSERT INTO document_accounts (document_id, account_id) VALUES (?, ?)');
        for (const accountId of caldav_account_ids) {
          insertAccount.run(id, accountId);
        }
      }
    });

    transaction();
    
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
