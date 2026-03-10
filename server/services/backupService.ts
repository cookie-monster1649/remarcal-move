import db from '../db.js';
import { decrypt } from './encryptionService.js';
import { SSHService } from './sshService.js';
import { buildBackupManifest } from './backupManifest.js';
import { cleanupBackupsForDevice } from './backupRetention.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const XOCHITL_REMOTE_PATH = '/home/root/.local/share/remarkable/xochitl/';

const runningByDevice = new Set<string>();

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

function buildDeviceSshConfig(device: any) {
  const decryptedPrivateKey = device.encrypted_private_key ? decrypt(device.encrypted_private_key) : undefined;
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
  async startDeviceBackup(deviceId: string): Promise<{ backupId: string }> {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as any;
    if (!device) {
      throw new Error('Device not found');
    }

    if (runningByDevice.has(deviceId)) {
      throw new Error('A backup is already running for this device');
    }

    const backupId = uuidv4();
    const startedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO device_backups (id, device_id, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(backupId, deviceId, startedAt);

    runningByDevice.add(deviceId);
    void this.runBackupJob(backupId, device)
      .catch((err) => {
        console.warn(`Backup job ${backupId} failed:`, err);
      })
      .finally(() => {
        runningByDevice.delete(deviceId);
      });

    return { backupId };
  }

  private async runBackupJob(backupId: string, device: any): Promise<void> {
    const dataDir = getDataDir();
    const timestamp = formatSnapshotTimestamp();
    const root = path.join(dataDir, 'backups', device.id, timestamp);
    const xochitlPath = path.join(root, 'xochitl');
    const manifestPath = path.join(root, 'manifest.json');
    const appVersion = getAppVersion();

    try {
      fs.mkdirSync(xochitlPath, { recursive: true });

      const ssh = new SSHService(buildDeviceSshConfig(device));
      const snapshot = await ssh.snapshotXochitlDirectory(XOCHITL_REMOTE_PATH, xochitlPath);

      const { manifest, hadErrors } = await buildBackupManifest(
        backupId,
        device.id,
        timestamp,
        appVersion,
        xochitlPath,
        4,
      );

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const status = hadErrors ? 'partial' : 'success';
      const completedAt = new Date().toISOString();
      db.prepare(`
        UPDATE device_backups
        SET status = ?, completed_at = ?, backup_path = ?, doc_count = ?, byte_count = ?, error = ?
        WHERE id = ?
      `).run(
        status,
        completedAt,
        root,
        manifest.stats.documentCount,
        manifest.stats.totalBytes,
        hadErrors ? `Backup completed with warnings via ${snapshot.method}` : null,
        backupId,
      );

      db.prepare('UPDATE devices SET last_backup_at = ? WHERE id = ?').run(completedAt, device.id);
      await cleanupBackupsForDevice(device.id);
    } catch (err: any) {
      db.prepare(`
        UPDATE device_backups
        SET status = 'error', completed_at = ?, backup_path = ?, error = ?
        WHERE id = ?
      `).run(new Date().toISOString(), root, err?.message || String(err), backupId);
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
      if (connectedDeviceIds && !connectedDeviceIds.has(device.id)) continue;
      if (runningByDevice.has(device.id)) continue;

      const running = db.prepare(
        "SELECT id FROM device_backups WHERE device_id = ? AND status = 'running' LIMIT 1",
      ).get(device.id) as any;
      if (running) continue;
      if (!this.isBackupDue(device)) continue;

      try {
        await this.startDeviceBackup(device.id);
      } catch (err: any) {
        console.warn(`Failed to start due backup for device ${device.id}: ${err?.message || err}`);
      }
    }
  }
}

export const backupService = new BackupService();
