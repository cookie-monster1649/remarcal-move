import express from 'express';
import db from '../db.js';
import { SyncService } from '../services/syncService.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getErrorMessage,
  isObject,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireString,
  ValidationError,
} from '../utils/validation.js';

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
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const title = requireString(req.body.title, 'title');
    const remote_path = requireString(req.body.remote_path, 'remote_path');
    const caldav_account_ids = optionalStringArray(req.body.caldav_account_ids, 'caldav_account_ids') || [];
    const device_id = optionalString(req.body.device_id, 'device_id');
    const year = optionalInteger(req.body.year, 'year', 1970, 2100) || new Date().getFullYear();
    const timezone = optionalString(req.body.timezone, 'timezone') || 'UTC';

    const id = uuidv4();

    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO documents (id, title, type, remote_path, caldav_account_id, device_id, year, timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, 'pdf', remote_path, caldav_account_ids?.[0] || null, device_id, year || new Date().getFullYear(), timezone || 'UTC');

      if (Array.isArray(caldav_account_ids)) {
        const insertAccount = db.prepare('INSERT INTO document_accounts (document_id, account_id) VALUES (?, ?)');
        for (const accountId of caldav_account_ids) {
          insertAccount.run(id, accountId);
        }
      }
    });

    transaction();
    
    res.json({ id, message: 'Document created' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Update Document
router.put('/:id', (req, res) => {
  const { id } = req.params;
  
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const title = requireString(req.body.title, 'title');
    const remote_path = requireString(req.body.remote_path, 'remote_path');
    const caldav_account_ids = optionalStringArray(req.body.caldav_account_ids, 'caldav_account_ids') || [];
    const device_id = optionalString(req.body.device_id, 'device_id');
    const year = optionalInteger(req.body.year, 'year', 1970, 2100) || new Date().getFullYear();
    const timezone = optionalString(req.body.timezone, 'timezone') || 'UTC';

    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE documents 
        SET title = ?, remote_path = ?, caldav_account_id = ?, device_id = ?, year = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(title, remote_path, caldav_account_ids?.[0] || null, device_id, year, timezone || 'UTC', id);

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
    
    res.json({ message: 'Document updated' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Delete Document
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
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
