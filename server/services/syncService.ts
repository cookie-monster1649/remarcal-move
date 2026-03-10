import db from '../db.js';
import { CalDavService } from './caldavService.js';
import { PDFService } from './pdfService.js';
import { SSHService } from './sshService.js';
import { decrypt } from './encryptionService.js';
import { sshKeyManager } from './sshKeyManager.js';
import { subscriptionService } from './subscriptionService.js';
import { deviceOperationService } from './deviceOperationService.js';
import { infoLogService } from './infoLogService.js';
import * as fs from 'fs';
import * as path from 'path';
import { traceConfig } from '../utils/traceConfig.js';

const calDavService = new CalDavService();
const pdfService = new PDFService();
function traceLog(message: string, payload?: Record<string, unknown>) {
  if (!traceConfig.sync) return;
  if (payload) {
    console.log(`[calendar-trace] ${message}`, payload);
    return;
  }
  console.log(`[calendar-trace] ${message}`);
}

function buildDeviceSshConfig(device: any) {
  const fsPrivateKey = sshKeyManager.loadDevicePrivateKey(device.id);
  const decryptedPrivateKey = fsPrivateKey || (device.encrypted_private_key ? decrypt(device.encrypted_private_key) : undefined);
  const decryptedPassword = device.encrypted_password ? decrypt(device.encrypted_password) : undefined;
  const authMode = device.auth_mode || 'password';

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

export class SyncService {
  async generateDocumentPDF(docId: string) {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    if (!doc) throw new Error(`Document ${docId} not found`);

    const linkedAccounts = db.prepare(`
      SELECT a.* FROM caldav_accounts a
      JOIN document_accounts da ON a.id = da.account_id
      WHERE da.document_id = ?
    `).all(docId) as any[];

    if (linkedAccounts.length === 0 && doc.caldav_account_id) {
      const legacyAccount = db.prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(doc.caldav_account_id) as any;
      if (legacyAccount) linkedAccounts.push(legacyAccount);
    }

    const linkedSubscriptions = db.prepare(`
      SELECT s.* FROM calendar_subscriptions s
      JOIN document_subscriptions ds ON s.id = ds.subscription_id
      WHERE ds.document_id = ? AND s.enabled = 1
    `).all(docId) as any[];

    if (linkedAccounts.length === 0 && linkedSubscriptions.length === 0) {
      throw new Error('No calendar sources configured for this document');
    }

    const year = doc.year || new Date().getFullYear();
    const targetTimezone = doc.timezone || 'UTC';
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    const allEvents = [];

    for (const account of linkedAccounts) {
      const password = decrypt(account.encrypted_password);
      let selectedCalendars = [];
      try {
        selectedCalendars = JSON.parse(account.selected_calendars || '[]');
      } catch (e) {
        console.warn('Failed to parse selected_calendars for account', account.id);
      }

      const calendarUrls = selectedCalendars.length > 0
        ? selectedCalendars.map((c: any) => c.url)
        : [account.url];

      for (const url of calendarUrls) {
        try {
          const { events } = await calDavService.fetchEvents({
            url,
            username: account.username,
            password: password,
            startDate,
            endDate
          });

          allEvents.push(...events);
        } catch (err: any) {
          console.warn(`Failed to fetch events for account ${account.name} calendar ${url}:`, err.message);
        }
      }
    }

    for (const subscription of linkedSubscriptions) {
      try {
        await subscriptionService.fetchSubscription(subscription.id, {
          rangeStart: new Date(`${startDate}T00:00:00.000Z`),
          rangeEnd: new Date(`${endDate}T23:59:59.999Z`),
        });
      } catch (err: any) {
        console.warn(`Failed refreshing subscription ${subscription.id}: ${err.message}`);
      }

      const subEvents = db.prepare(`
        SELECT summary, start_at, end_at, location, description, all_day, timezone, participation_status
        FROM subscription_events
        WHERE subscription_id = ? AND end_at >= ? AND start_at <= ?
      `).all(subscription.id, `${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`) as any[];

      if (traceConfig.sync) {
        const distinct = db.prepare(`
          SELECT COUNT(DISTINCT start_at) AS distinct_starts
          FROM subscription_events
          WHERE subscription_id = ? AND end_at >= ? AND start_at <= ?
        `).get(subscription.id, `${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`) as any;

        traceLog('sync:subscription-db-range', {
          docId,
          subscriptionId: subscription.id,
          totalRows: subEvents.length,
          distinctStarts: distinct?.distinct_starts ?? 0,
          rangeStart: `${startDate}T00:00:00.000Z`,
          rangeEnd: `${endDate}T23:59:59.999Z`,
        });
      }

      for (const event of subEvents) {
        allEvents.push({
          summary: event.summary || 'Untitled Event',
          start: new Date(event.start_at),
          end: new Date(event.end_at),
          location: event.location || undefined,
          description: event.description || undefined,
          allDay: !!event.all_day,
          timezone: event.timezone || undefined,
          participationStatus: event.participation_status || undefined,
        });
      }
    }

    if (traceConfig.sync) {
      const sample = allEvents.slice(0, traceConfig.limit).map((e: any) => ({
        summary: e.summary,
        startIso: e.start instanceof Date && Number.isFinite(e.start.getTime()) ? e.start.toISOString() : null,
        endIso: e.end instanceof Date && Number.isFinite(e.end.getTime()) ? e.end.toISOString() : null,
        allDay: !!e.allDay,
        timezone: e.timezone || null,
      }));

      const distinctStartCount = new Set(
        sample
          .map((e) => e.startIso)
          .filter((v): v is string => !!v),
      ).size;

      traceLog('sync:pdf-input-sample', {
        docId,
        totalAllEvents: allEvents.length,
        sampleCount: sample.length,
        sampleDistinctStarts: distinctStartCount,
        sample,
      });
    }

    const pdfBuffer = pdfService.generate(allEvents, { year, timezone: targetTimezone });
    const localPath = path.join(process.env.DATA_DIR || './data', 'docs', `${docId}.pdf`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, pdfBuffer);

    return { doc, localPath };
  }

  async syncDocument(docId: string) {
    // 1. Get Document
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    if (!doc) throw new Error(`Document ${docId} not found`);

    try {
      if (!doc.device_id) {
        throw new Error('Device must be configured for sync');
      }

      const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(doc.device_id) as any;
      if (!device) throw new Error('Device not found');

      const lock = deviceOperationService.tryAcquire(device.id, 'sync');
      if (lock.ok === false) {
        throw new Error(lock.reason);
      }

      // Update status to syncing
      db.prepare('UPDATE documents SET sync_status = ?, last_error = NULL WHERE id = ?').run('syncing', docId);
      infoLogService.write('sync.started', { docId, deviceId: device.id, remotePath: doc.remote_path });

      try {
        const { localPath } = await this.generateDocumentPDF(docId);

        const sshConfig = buildDeviceSshConfig(device);
        const deviceSshService = new SSHService(sshConfig);
        await deviceSshService.uploadPDF(doc.remote_path, localPath, doc.title);

        // 5. Update Status
        const completedAt = new Date().toISOString();
        db.prepare('UPDATE documents SET sync_status = ?, last_synced_at = ? WHERE id = ?').run('idle', completedAt, docId);
        infoLogService.write('sync.completed', { docId, deviceId: device.id, at: completedAt });
      } finally {
        deviceOperationService.release(device.id, 'sync');
      }

    } catch (error: any) {
      console.error(`Sync failed for doc ${docId}:`, error);
      db.prepare('UPDATE documents SET sync_status = ?, last_error = ? WHERE id = ?').run('error', error.message, docId);
      infoLogService.write('sync.failed', { docId, error: error.message }, 'error');
      throw error;
    }
  }
}
