import express from 'express';
import db from '../db.js';
import { SyncService } from '../services/syncService.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
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
  
  // For each document, fetch its linked accounts and subscriptions
  const docsWithAccounts = docs.map(doc => {
    const accounts = db.prepare('SELECT account_id FROM document_accounts WHERE document_id = ?').all(doc.id) as any[];
    const subscriptions = db.prepare('SELECT subscription_id FROM document_subscriptions WHERE document_id = ?').all(doc.id) as any[];
    return {
      ...doc,
      caldav_account_ids: accounts.map(a => a.account_id),
      subscription_ids: subscriptions.map(s => s.subscription_id),
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
    const subscription_ids = optionalStringArray(req.body.subscription_ids, 'subscription_ids') || [];
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

      if (Array.isArray(subscription_ids)) {
        const insertSubscription = db.prepare('INSERT INTO document_subscriptions (document_id, subscription_id) VALUES (?, ?)');
        for (const subscriptionId of subscription_ids) {
          insertSubscription.run(id, subscriptionId);
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
    const subscription_ids = optionalStringArray(req.body.subscription_ids, 'subscription_ids') || [];
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

      db.prepare('DELETE FROM document_subscriptions WHERE document_id = ?').run(id);
      if (Array.isArray(subscription_ids)) {
        const insertSubscription = db.prepare('INSERT INTO document_subscriptions (document_id, subscription_id) VALUES (?, ?)');
        for (const subscriptionId of subscription_ids) {
          insertSubscription.run(id, subscriptionId);
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
    res.json({ message: 'Sync completed' });
  } catch (err: any) {
    const message = err?.message || 'Sync failed';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    if (message.includes('already in progress')) {
      return res.status(409).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

// Cancel/Reset Sync
router.post('/:id/sync/cancel', (req, res) => {
  const { id } = req.params;
  try {
    const cancelled = syncService.cancelSync(id);
    if (!cancelled) {
      return res.status(404).json({ error: 'No active or queued sync found for this document' });
    }
    return res.json({ message: 'Sync cancel requested; status reset to idle' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Download PDF (generate on-demand if needed)
router.get('/:id/download', async (req, res) => {
  const { id } = req.params;
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const localPath = path.resolve(path.join(process.env.DATA_DIR || './data', 'docs', `${id}.pdf`));
    if (!fs.existsSync(localPath)) {
      await syncService.generateDocumentPDF(id);
    }

    if (!fs.existsSync(localPath)) {
      return res.status(500).json({ error: 'Failed to generate PDF' });
    }

    const safeTitle = (doc.title || `document-${id}`)
      .toString()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || `document-${id}`;
    const filename = `${safeTitle}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.sendFile(localPath);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
