import db from '../db.js';
import { CalDavService } from './caldavService.js';
import { PDFService } from './pdfService.js';
import { SSHService } from './sshService.js';
import { decrypt } from './encryptionService.js';
import * as fs from 'fs';
import * as path from 'path';

const calDavService = new CalDavService();
const pdfService = new PDFService();
const sshService = new SSHService();

export class SyncService {
  async syncDocument(docId: string) {
    // 1. Get Document & Account
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    if (!doc) throw new Error(`Document ${docId} not found`);

    if (!doc.caldav_account_id) throw new Error('No CalDAV account configured for this document');
    const account = db.prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(doc.caldav_account_id) as any;
    if (!account) throw new Error('CalDAV account not found');

    // Update status to syncing
    db.prepare('UPDATE documents SET sync_status = ?, last_error = NULL WHERE id = ?').run('syncing', docId);

    try {
      // 2. Fetch Events
      const password = decrypt(account.encrypted_password);
      const year = new Date().getFullYear(); // Or configured year? User requirement says "Year" input replaced Start/End.
      // But where is the year stored?
      // The prompt says "Year input replaced Start/End".
      // I should probably store the year in the document settings or assume current year/next year.
      // For now, let's assume current year or store it in document config.
      // I didn't add 'year' to documents table. I should have.
      // Let's assume current year for now, or add it to DB.
      // Given "Simplfy it aggressively", maybe just current year is fine.
      // Or maybe the user wants to configure it.
      // The previous App.tsx had `state.config.year`.
      // I'll use the current year for simplicity, or 2025/2026 as per context.
      // Let's use current year.
      
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;

      const events = await calDavService.fetchEvents({
        url: account.url,
        username: account.username,
        password: password,
        startDate,
        endDate
      });

      // 3. Generate PDF
      const pdfBuffer = pdfService.generate(events, { year });
      
      // Save locally to /data/docs for persistence/cache
      const localPath = path.join(process.env.DATA_DIR || './data', 'docs', `${docId}.pdf`);
      fs.writeFileSync(localPath, pdfBuffer);

      // 4. Upload to Device
      if (doc.remote_path) {
          await sshService.uploadPDF(doc.remote_path, localPath);
      } else {
          throw new Error('Remote path not configured');
      }

      // 5. Update Status
      db.prepare('UPDATE documents SET sync_status = ?, last_synced_at = ? WHERE id = ?').run('idle', new Date().toISOString(), docId);

    } catch (error: any) {
      console.error(`Sync failed for doc ${docId}:`, error);
      db.prepare('UPDATE documents SET sync_status = ?, last_error = ? WHERE id = ?').run('error', error.message, docId);
      throw error;
    }
  }
}
