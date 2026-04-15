import db from '../db.js';
import { PDFService } from './pdfService.js';
import { SSHService } from './sshService.js';
import { decrypt } from './encryptionService.js';
import { sshKeyManager } from './sshKeyManager.js';
import { subscriptionService } from './subscriptionService.js';
import { caldavPollerService } from './caldavPollerService.js';
import { deviceOperationService } from './deviceOperationService.js';
import { infoLogService } from './infoLogService.js';
import * as fs from 'fs';
import * as path from 'path';
import { traceConfig } from '../utils/traceConfig.js';

const pdfService = new PDFService();
const DEFAULT_SYNC_OPERATION_TIMEOUT_MS = 3 * 60 * 1000;
const cancelRequested = new Set<string>();
const activeSyncByDoc = new Set<string>();
type SyncPhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'generating_pdf'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'cancelled'
  | 'error';

const DEVICE_CONNECTIVITY_TIMEOUT_MS = 12_000;

function getSyncTimeoutMs(): number {
  const raw = Number(process.env.SYNC_OPERATION_TIMEOUT_MS || DEFAULT_SYNC_OPERATION_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 30_000) {
    return DEFAULT_SYNC_OPERATION_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ensureNotCancelled(docId: string) {
  if (!cancelRequested.has(docId)) return;
  const err: any = new Error('Sync cancelled by user');
  err.syncCancelled = true;
  throw err;
}
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

const queuedSyncByDevice = new Map<string, Set<string>>();
const queuedSyncTimers = new Map<string, NodeJS.Timeout>();

export class SyncService {
  private setSyncState(docId: string, state: { status?: string; phase?: SyncPhase; progress?: number; error?: string | null }) {
    const current = db.prepare('SELECT sync_status, sync_phase, sync_progress, last_error FROM documents WHERE id = ?').get(docId) as any;
    if (!current) return;

    const status = state.status ?? current.sync_status ?? 'idle';
    const phase = state.phase ?? current.sync_phase ?? 'idle';
    const progress = Math.max(0, Math.min(100, Math.round(state.progress ?? current.sync_progress ?? 0)));
    const error = state.error !== undefined ? state.error : current.last_error;

    db.prepare(`
      UPDATE documents
      SET sync_status = ?,
          sync_phase = ?,
          sync_progress = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, phase, progress, error, docId);
  }

  private buildUploadProgressReporter(docId: string): (transferredBytes: number, totalBytes: number) => void {
    let lastPercent = -1;
    let lastUpdateAt = 0;
    return (transferredBytes: number, totalBytes: number) => {
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) return;
      const raw = Math.floor((transferredBytes / totalBytes) * 100);
      const uploadPercent = Math.max(0, Math.min(100, raw));
      const overall = 65 + Math.floor(uploadPercent * 0.30); // map upload to 65-95%
      const now = Date.now();
      if (Math.abs(overall - lastPercent) < 2 && now - lastUpdateAt < 500) return;
      lastPercent = overall;
      lastUpdateAt = now;
      this.setSyncState(docId, { status: 'syncing', phase: 'uploading', progress: overall, error: null });
    };
  }

  private async isDeviceConnected(device: any): Promise<boolean> {
    try {
      const testConfig = {
        ...buildDeviceSshConfig(device),
        readyTimeout: 5000,
      };
      const service = new SSHService(testConfig);
      await withTimeout(
        service.testConnection(),
        DEVICE_CONNECTIVITY_TIMEOUT_MS,
        'Device connectivity check timed out',
      );
      return true;
    } catch {
      return false;
    }
  }

  cancelSync(docId: string): boolean {
    cancelRequested.add(docId);

    let removedFromQueue = false;
    for (const [deviceId, queued] of queuedSyncByDevice.entries()) {
      if (!queued.delete(docId)) continue;
      removedFromQueue = true;
      if (queued.size === 0) {
        queuedSyncByDevice.delete(deviceId);
      }
    }

    this.setSyncState(docId, {
      status: 'idle',
      phase: 'cancelled',
      progress: 0,
      error: 'Sync cancelled by user',
    });
    const reset = db.prepare('SELECT changes() AS changes').get() as any;

    infoLogService.write('sync.cancel_requested', {
      docId,
      active: activeSyncByDoc.has(docId),
      queued: removedFromQueue,
      resetRows: reset.changes,
    }, 'warn');

    return activeSyncByDoc.has(docId) || removedFromQueue || reset.changes > 0;
  }

  private queueSync(deviceId: string, docId: string): void {
    const existing = queuedSyncByDevice.get(deviceId) || new Set<string>();
    existing.add(docId);
    queuedSyncByDevice.set(deviceId, existing);
  }

  private scheduleQueuedSyncAttempt(deviceId: string): void {
    if (queuedSyncTimers.has(deviceId)) return;
    const timer = setTimeout(async () => {
      queuedSyncTimers.delete(deviceId);
      await this.runQueuedSyncs(deviceId);
    }, 1500);
    queuedSyncTimers.set(deviceId, timer);
  }

  private async runQueuedSyncs(deviceId: string): Promise<void> {
    const queued = queuedSyncByDevice.get(deviceId);
    if (!queued || queued.size === 0) return;

    const lock = deviceOperationService.getCurrent(deviceId);
    if (lock?.operation === 'backup') {
      this.scheduleQueuedSyncAttempt(deviceId);
      return;
    }

    const docIds = Array.from(queued);
    queuedSyncByDevice.delete(deviceId);

    for (const docId of docIds) {
      try {
        await this.syncDocument(docId);
      } catch {
        // syncDocument handles status/logging; keep queue flow resilient
      }
    }
  }

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
      // Refresh the account's events for this document year, then read from DB.
      // This mirrors the subscription pattern: fresh fetch → DB read → PDF render.
      try {
        await caldavPollerService.fetchAccount(account.id, {
          rangeStart: new Date(`${startDate}T00:00:00.000Z`),
          rangeEnd: new Date(`${endDate}T23:59:59.999Z`),
        });
      } catch (err: any) {
        console.warn(`Failed to refresh CalDAV account ${account.name}: ${err.message}`);
      }

      const accountEvents = db.prepare(`
        SELECT summary, start_at, end_at, location, description, all_day, timezone
        FROM caldav_events
        WHERE account_id = ? AND end_at >= ? AND start_at <= ?
      `).all(account.id, `${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`) as any[];

      for (const event of accountEvents) {
        allEvents.push({
          summary: event.summary || 'Untitled Event',
          start: new Date(event.start_at),
          end: new Date(event.end_at),
          location: event.location || undefined,
          description: event.description || undefined,
          allDay: !!event.all_day,
          timezone: event.timezone || undefined,
        });
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
    const timeoutMs = getSyncTimeoutMs();

    // 1. Get Document
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    if (!doc) throw new Error(`Document ${docId} not found`);

    try {
      if (!doc.device_id) {
        infoLogService.write('sync.skipped', { docId, reason: 'device_not_configured' }, 'warn');
        const err: any = new Error('Device must be configured for sync');
        err.syncSkipped = true;
        throw err;
      }

      const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(doc.device_id) as any;
      if (!device) {
        infoLogService.write('sync.skipped', { docId, deviceId: doc.device_id, reason: 'device_not_found' }, 'warn');
        const err: any = new Error('Device not found');
        err.syncSkipped = true;
        throw err;
      }

      const lock = deviceOperationService.tryAcquire(device.id, 'sync');
      if (lock.ok === false) {
        const busyWithBackup = lock.reason.includes('backup');
        if (busyWithBackup) {
          this.queueSync(device.id, docId);
          this.setSyncState(docId, { status: 'queued', phase: 'queued', progress: 0, error: null });
          infoLogService.write('sync.queued', { docId, deviceId: device.id, reason: lock.reason }, 'info');
          this.scheduleQueuedSyncAttempt(device.id);
          return;
        }

        infoLogService.write('sync.skipped', { docId, deviceId: device.id, reason: 'device_busy', detail: lock.reason }, 'warn');
        const err: any = new Error(lock.reason);
        err.syncSkipped = true;
        throw err;
      }

      // Start with connectivity verification before doing expensive sync work.
      this.setSyncState(docId, { status: 'checking', phase: 'preparing', progress: 2, error: null });
      activeSyncByDoc.add(docId);

      try {
        ensureNotCancelled(docId);
        const connected = await this.isDeviceConnected(device);
        if (!connected) {
          const pendingErr: any = new Error('Pending connection');
          pendingErr.syncPendingConnection = true;
          pendingErr.syncSkipped = true;
          throw pendingErr;
        }

        this.setSyncState(docId, { status: 'syncing', phase: 'preparing', progress: 5, error: null });
        infoLogService.write('sync.started', { docId, deviceId: device.id, remotePath: doc.remote_path });
        this.setSyncState(docId, { status: 'syncing', phase: 'generating_pdf', progress: 25, error: null });

        const { localPath } = await withTimeout(
          this.generateDocumentPDF(docId),
          timeoutMs,
          `PDF generation timed out after ${timeoutMs}ms`,
        );
        ensureNotCancelled(docId);
        this.setSyncState(docId, { status: 'syncing', phase: 'uploading', progress: 65, error: null });

        const sshConfig = buildDeviceSshConfig(device);
        const deviceSshService = new SSHService(sshConfig);
        await withTimeout(
          deviceSshService.uploadPDF(doc.remote_path, localPath, doc.title, {
            onProgress: this.buildUploadProgressReporter(docId),
          }),
          timeoutMs,
          `PDF upload timed out after ${timeoutMs}ms`,
        );
        ensureNotCancelled(docId);
        this.setSyncState(docId, { status: 'syncing', phase: 'finalizing', progress: 95, error: null });

        // 5. Update Status
        const completedAt = new Date().toISOString();
        db.prepare(`
          UPDATE documents
          SET sync_status = 'idle',
              sync_phase = 'done',
              sync_progress = 100,
              last_synced_at = ?,
              last_error = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(completedAt, docId);
        infoLogService.write('sync.completed', { docId, deviceId: device.id, at: completedAt });
      } finally {
        deviceOperationService.release(device.id, 'sync');
        activeSyncByDoc.delete(docId);
        cancelRequested.delete(docId);
        this.scheduleQueuedSyncAttempt(device.id);
      }

    } catch (error: any) {
      console.error(`Sync failed for doc ${docId}:`, error);
      const message = error?.message || 'Unknown sync error';
      const cancelled = !!error?.syncCancelled || String(message).toLowerCase().includes('cancel');
      const pendingConnection = !!error?.syncPendingConnection || String(message).toLowerCase().includes('pending connection');
      if (cancelled) {
        this.setSyncState(docId, { status: 'idle', phase: 'cancelled', progress: 0, error: 'Sync cancelled by user' });
        infoLogService.write('sync.cancelled', { docId }, 'warn');
      } else if (pendingConnection) {
        this.setSyncState(docId, { status: 'pending_connection', phase: 'queued', progress: 0, error: null });
        infoLogService.write('sync.pending_connection', { docId, deviceId: doc.device_id }, 'warn');
      } else {
        this.setSyncState(docId, { status: 'error', phase: 'error', progress: 0, error: message });
      }
      if (error?.syncSkipped) {
        infoLogService.write('sync.skipped', { docId, reason: 'precondition_failed', detail: error.message }, 'warn');
      } else if (!cancelled) {
        infoLogService.write('sync.failed', { docId, error: error.message }, 'error');
      }
      throw error;
    }
  }
}
