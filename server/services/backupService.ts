import db from '../db.js';
import { decrypt } from './encryptionService.js';
import { SSHService } from './sshService.js';
import { buildBackupManifest } from './backupManifest.js';
import { cleanupBackupsForDevice } from './backupRetention.js';
import { deviceOperationService } from './deviceOperationService.js';
import { infoLogService } from './infoLogService.js';
import { sshKeyManager } from './sshKeyManager.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const XOCHITL_REMOTE_PATH = '/home/root/.local/share/remarkable/xochitl/';

const runningByDevice = new Set<string>();
const cancelRequested = new Set<string>();
const queuedBackupByDevice = new Set<string>();
const queuedBackupTimers = new Map<string, NodeJS.Timeout>();

export interface BackupProgressState {
  backupId: string;
  deviceId: string;
  phase: 'preflight' | 'transfer' | 'manifest' | 'finalize' | 'done' | 'cancelled' | 'error';
  transferredBytes: number;
  totalBytes: number;
  totalFiles: number;
  speedBytesPerSec?: number;
  percent?: number;
  updatedAt: string;
  message?: string;
}

const progressByBackupId = new Map<string, BackupProgressState>();

function formatSnapshotTimestamp(d = new Date()): string {
  const iso = d.toISOString();
  return iso.replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

function getAppVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getDataDir(): string {
  return process.env.DATA_DIR || './data';
}

function cloneDirectoryWithHardlinks(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(sourceDir, entry.name);
    const dstPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      cloneDirectoryWithHardlinks(srcPath, dstPath);
      continue;
    }
    if (entry.isFile()) {
      try {
        fs.linkSync(srcPath, dstPath);
      } catch {
        // Fallback for environments/filesystems that do not support hard links
        fs.copyFileSync(srcPath, dstPath);
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, dstPath);
    }
  }
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
    readyTimeout: 20_000,
  };
}

export class BackupService {
  private scheduleQueuedBackupAttempt(deviceId: string): void {
    if (queuedBackupTimers.has(deviceId)) return;
    const timer = setTimeout(async () => {
      queuedBackupTimers.delete(deviceId);
      await this.runQueuedBackup(deviceId);
    }, 1500);
    queuedBackupTimers.set(deviceId, timer);
  }

  private async runQueuedBackup(deviceId: string): Promise<void> {
    if (!queuedBackupByDevice.has(deviceId)) return;
    const current = deviceOperationService.getCurrent(deviceId);
    if (current?.operation === 'sync' || current?.operation === 'backup') {
      this.scheduleQueuedBackupAttempt(deviceId);
      return;
    }

    queuedBackupByDevice.delete(deviceId);
    try {
      await this.startDeviceBackup(deviceId);
    } catch {
      queuedBackupByDevice.add(deviceId);
      this.scheduleQueuedBackupAttempt(deviceId);
    }
  }

  getBackupProgress(backupId: string): BackupProgressState | null {
    return progressByBackupId.get(backupId) || null;
  }

  cancelBackup(backupId: string): void {
    cancelRequested.add(backupId);
    const current = progressByBackupId.get(backupId);
    if (current) {
      progressByBackupId.set(backupId, {
        ...current,
        updatedAt: new Date().toISOString(),
        message: 'Cancel requested',
      });
    }
    infoLogService.write('backup.cancel_requested', { backupId }, 'warn');
  }

  async startDeviceBackup(deviceId: string): Promise<{ backupId?: string; queued?: boolean }> {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as any;
    if (!device) {
      infoLogService.write('backup.skipped', { deviceId, reason: 'device_not_found' }, 'warn');
      throw new Error('Device not found');
    }

    if (runningByDevice.has(deviceId)) {
      infoLogService.write('backup.skipped', { deviceId, reason: 'already_running' }, 'warn');
      throw new Error('A backup is already running for this device');
    }

    const lock = deviceOperationService.tryAcquire(deviceId, 'backup');
    if (lock.ok === false) {
      const busyWithSync = lock.reason.includes('sync');
      if (busyWithSync) {
        queuedBackupByDevice.add(deviceId);
        infoLogService.write('backup.queued', { deviceId, reason: lock.reason }, 'info');
        this.scheduleQueuedBackupAttempt(deviceId);
        return { queued: true };
      }
      infoLogService.write('backup.skipped', { deviceId, reason: 'device_busy', detail: lock.reason }, 'warn');
      throw new Error(lock.reason);
    }

    const backupId = uuidv4();
    const startedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO device_backups (id, device_id, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(backupId, deviceId, startedAt);

    runningByDevice.add(deviceId);
    infoLogService.write('backup.started', { backupId, deviceId });

    void this.runBackupJob(backupId, device)
      .catch((err) => {
        console.warn(`Backup job ${backupId} failed:`, err);
      })
      .finally(() => {
        runningByDevice.delete(deviceId);
        cancelRequested.delete(backupId);
        deviceOperationService.release(deviceId, 'backup');
        this.scheduleQueuedBackupAttempt(deviceId);
      });

    return { backupId };
  }

  private async runBackupJob(backupId: string, device: any): Promise<void> {
    const dataDir = getDataDir();
    const timestamp = formatSnapshotTimestamp();
    const deviceBackupsRoot = path.join(dataDir, 'backups', device.id);
    const mirrorRoot = path.join(deviceBackupsRoot, '.mirror');
    const mirrorXochitlPath = path.join(mirrorRoot, 'xochitl');
    const rootFinal = path.join(deviceBackupsRoot, timestamp);
    const root = `${rootFinal}.inprogress`;
    const xochitlPath = path.join(root, 'xochitl');
    const manifestPath = path.join(root, 'manifest.json');
    const appVersion = getAppVersion();
    let lastProgressTs = Date.now();
    let lastTransferred = 0;

    const setProgress = (partial: Partial<BackupProgressState>) => {
      const prev = progressByBackupId.get(backupId);
      const next: BackupProgressState = {
        backupId,
        deviceId: device.id,
        phase: partial.phase || prev?.phase || 'preflight',
        transferredBytes: partial.transferredBytes ?? prev?.transferredBytes ?? 0,
        totalBytes: partial.totalBytes ?? prev?.totalBytes ?? 0,
        totalFiles: partial.totalFiles ?? prev?.totalFiles ?? 0,
        speedBytesPerSec: partial.speedBytesPerSec ?? prev?.speedBytesPerSec,
        percent: partial.percent ?? prev?.percent,
        updatedAt: new Date().toISOString(),
        message: partial.message ?? prev?.message,
      };
      progressByBackupId.set(backupId, next);
    };

    try {
      fs.mkdirSync(mirrorXochitlPath, { recursive: true });
      fs.mkdirSync(root, { recursive: true });

      const ssh = new SSHService(buildDeviceSshConfig(device));
      setProgress({ phase: 'preflight', message: 'Assessing remote data' });
      const preflight = await ssh.preflightXochitlDirectory(XOCHITL_REMOTE_PATH);
      setProgress({
        phase: 'preflight',
        totalBytes: preflight.totalBytes,
        totalFiles: preflight.totalFiles,
        transferredBytes: 0,
        percent: preflight.totalBytes > 0 ? 0 : 100,
      });
      infoLogService.write('backup.preflight', {
        backupId,
        deviceId: device.id,
        totalFiles: preflight.totalFiles,
        totalBytes: preflight.totalBytes,
      });

      const snapshot = await ssh.snapshotXochitlDirectory(XOCHITL_REMOTE_PATH, mirrorXochitlPath, {
        expectedTotalBytes: preflight.totalBytes,
        isCancelled: () => cancelRequested.has(backupId),
        onProgress: (p) => {
          const now = Date.now();
          const dt = Math.max(1, now - lastProgressTs) / 1000;
          const delta = Math.max(0, p.transferredBytes - lastTransferred);
          const speed = delta / dt;
          lastProgressTs = now;
          lastTransferred = p.transferredBytes;
          const percent = preflight.totalBytes > 0
            ? Math.min(100, Math.round((p.transferredBytes / preflight.totalBytes) * 1000) / 10)
            : undefined;

          setProgress({
            phase: 'transfer',
            transferredBytes: p.transferredBytes,
            totalBytes: preflight.totalBytes,
            totalFiles: preflight.totalFiles,
            speedBytesPerSec: speed,
            percent,
            message: p.currentFile || 'Incremental mirror sync',
          });
        },
      });

      if (cancelRequested.has(backupId)) {
        throw new Error('Backup cancelled');
      }

      setProgress({ phase: 'finalize', message: 'Creating snapshot from mirror' });
      cloneDirectoryWithHardlinks(mirrorXochitlPath, xochitlPath);

      setProgress({ phase: 'manifest', message: 'Generating manifest' });

      const { manifest, hadErrors } = await buildBackupManifest(
        backupId,
        device.id,
        timestamp,
        appVersion,
        xochitlPath,
        4,
      );

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      setProgress({ phase: 'finalize', message: 'Finalizing snapshot' });
      fs.renameSync(root, rootFinal);

      const status = hadErrors ? 'partial' : 'success';
      const completedAt = new Date().toISOString();
      db.prepare(`
        UPDATE device_backups
        SET status = ?, completed_at = ?, backup_path = ?, doc_count = ?, byte_count = ?, error = ?
        WHERE id = ?
      `).run(
        status,
        completedAt,
        rootFinal,
        manifest.stats.documentCount,
        manifest.stats.totalBytes,
        hadErrors ? `Backup completed with warnings via ${snapshot.method}` : null,
        backupId,
      );

      db.prepare('UPDATE devices SET last_backup_at = ? WHERE id = ?').run(completedAt, device.id);
      setProgress({
        phase: 'done',
        transferredBytes: manifest.stats.totalBytes,
        totalBytes: manifest.stats.totalBytes,
        percent: 100,
        message: status === 'partial' ? 'Completed with warnings' : 'Completed',
      });
      infoLogService.write('backup.completed', {
        backupId,
        deviceId: device.id,
        status,
        method: snapshot.method,
        snapshotStrategy: 'mirror_hardlink',
        totalBytes: manifest.stats.totalBytes,
        totalFiles: manifest.stats.totalFiles,
      });
      await cleanupBackupsForDevice(device.id);
    } catch (err: any) {
      const cancelled = cancelRequested.has(backupId) || String(err?.message || '').toLowerCase().includes('cancel');
      db.prepare(`
        UPDATE device_backups
        SET status = ?, completed_at = ?, backup_path = ?, error = ?
        WHERE id = ?
      `).run(cancelled ? 'cancelled' : 'error', new Date().toISOString(), root, err?.message || String(err), backupId);
      setProgress({
        phase: cancelled ? 'cancelled' : 'error',
        message: err?.message || String(err),
      });
      infoLogService.write(cancelled ? 'backup.cancelled' : 'backup.failed', {
        backupId,
        deviceId: device.id,
        error: err?.message || String(err),
      }, cancelled ? 'warn' : 'error');
      throw err;
    }
  }

  private isBackupDue(device: any): boolean {
    const last = db.prepare(`
      SELECT completed_at
      FROM device_backups
      WHERE device_id = ? AND status IN ('success', 'partial')
      ORDER BY datetime(completed_at) DESC
      LIMIT 1
    `).get(device.id) as any;

    const freqHours = Number(device.backup_frequency_hours || 24);
    const dueMs = Math.max(1, freqHours) * 60 * 60 * 1000;
    const lastMs = last?.completed_at ? new Date(last.completed_at).getTime() : 0;
    return !lastMs || (Date.now() - lastMs >= dueMs);
  }

  async runDueBackups(connectedDeviceIds?: Set<string>): Promise<void> {
    const devices = db.prepare('SELECT * FROM devices WHERE backup_enabled = 1').all() as any[];

    for (const device of devices) {
      if (connectedDeviceIds && !connectedDeviceIds.has(device.id)) {
        infoLogService.write('backup.skipped', { deviceId: device.id, reason: 'device_offline' });
        continue;
      }
      if (runningByDevice.has(device.id)) {
        infoLogService.write('backup.skipped', { deviceId: device.id, reason: 'already_running' });
        continue;
      }
      if (deviceOperationService.getCurrent(device.id)) {
        infoLogService.write('backup.skipped', { deviceId: device.id, reason: 'device_busy' });
        continue;
      }

      const running = db.prepare(
        "SELECT id FROM device_backups WHERE device_id = ? AND status = 'running' LIMIT 1",
      ).get(device.id) as any;
      if (running) {
        infoLogService.write('backup.skipped', { deviceId: device.id, reason: 'backup_row_running' });
        continue;
      }
      if (!this.isBackupDue(device)) {
        infoLogService.write('backup.skipped', { deviceId: device.id, reason: 'not_due' });
        continue;
      }

      try {
        await this.startDeviceBackup(device.id);
      } catch (err: any) {
        console.warn(`Failed to start due backup for device ${device.id}: ${err?.message || err}`);
      }
    }
  }
}

export const backupService = new BackupService();
