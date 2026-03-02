import db from '../db.js';
import { CalDavService } from './caldavService.js';
import { PDFService } from './pdfService.js';
import { SSHService } from './sshService.js';
import { decrypt } from './encryptionService.js';
import * as fs from 'fs';
import * as path from 'path';
import { toDate, formatInTimeZone } from 'date-fns-tz';

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
      const year = doc.year || new Date().getFullYear();
      const targetTimezone = doc.timezone || 'UTC';
      
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;

      let selectedCalendars = [];
      try {
        selectedCalendars = JSON.parse(account.selected_calendars || '[]');
      } catch (e) {
        console.warn('Failed to parse selected_calendars for account', account.id);
      }

      const calendarUrls = selectedCalendars.length > 0 
        ? selectedCalendars.map((c: any) => c.url) 
        : [account.url];

      const allEvents = [];
      for (const url of calendarUrls) {
        try {
          const { events, timezone: calTz } = await calDavService.fetchEvents({
            url,
            username: account.username,
            password: password,
            startDate,
            endDate
          });
          
          // Process events to ensure they are in the target timezone
          const processedEvents = events.map(e => {
            // If the event has a specific timezone, we should respect it.
            // However, for the PDF generation, we want to know what time it is in the USER'S target timezone.
            // JS Date objects from ical.js are already absolute points in time.
            return {
              ...e,
              // We pass the Date object. PDFService will need to format it using the target timezone.
            };
          });
          
          allEvents.push(...processedEvents);
        } catch (err: any) {
          console.warn(`Failed to fetch events for calendar ${url}:`, err.message);
        }
      }

      // 3. Generate PDF
      const pdfBuffer = pdfService.generate(allEvents, { year, timezone: targetTimezone });
      
      // Save locally to /data/docs for persistence/cache
      const localPath = path.join(process.env.DATA_DIR || './data', 'docs', `${docId}.pdf`);
      fs.writeFileSync(localPath, pdfBuffer);

    // 4. Upload to Device
    if (doc.device_id) {
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(doc.device_id) as any;
        if (!device) throw new Error('Device not found');
        
        const sshConfig = {
            host: device.host,
            username: device.username,
            port: device.port,
            password: device.encrypted_password ? decrypt(device.encrypted_password) : undefined
        };
        
        const deviceSshService = new SSHService(sshConfig);
        await deviceSshService.uploadPDF(doc.remote_path, localPath, doc.title);
    } else {
        // Fallback to env vars if no device linked (legacy support or default)
        // But the prompt implies "register device... required before documents created".
        // So maybe we enforce device selection.
        // For backward compatibility with existing code that uses env vars, we can keep the default SSHService() which uses env vars.
        // But let's prefer the device_id if present.
        if (doc.remote_path) {
             await sshService.uploadPDF(doc.remote_path, localPath, doc.title);
        } else {
             throw new Error('Remote path not configured');
        }
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
