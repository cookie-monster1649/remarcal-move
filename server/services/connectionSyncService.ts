import db from '../db.js';
import { decrypt } from './encryptionService.js';
import { SSHService } from './sshService.js';
import { sshKeyManager } from './sshKeyManager.js';
import { SyncService } from './syncService.js';
import { backupService } from './backupService.js';

const POLL_INTERVAL_MS = 2 * 60 * 1000;

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
    readyTimeout: 5000,
  };
}

export class ConnectionSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private syncService = new SyncService();

  start() {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, POLL_INTERVAL_MS);
    console.log('Connection sync service started (poll every 2 minutes)');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runCycle() {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const devices = db
        .prepare('SELECT * FROM devices WHERE sync_when_connected = 1 OR backup_enabled = 1')
        .all() as any[];

      const connectedDeviceIds = new Set<string>();

      for (const device of devices) {
        const isConnected = await this.isDeviceConnected(device);
        if (!isConnected) {
          continue;
        }

        connectedDeviceIds.add(device.id);

        db.prepare('UPDATE devices SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), device.id);

        if (device.sync_when_connected) {
          const docs = db
            .prepare('SELECT id, sync_status FROM documents WHERE device_id = ?')
            .all(device.id) as any[];

          for (const doc of docs) {
            if (doc.sync_status === 'syncing') {
              continue;
            }

            try {
              await this.syncService.syncDocument(doc.id);
            } catch (err: any) {
              console.warn(`Sync-on-connect failed for document ${doc.id}: ${err?.message || err}`);
            }
          }
        }
      }

      try {
        await backupService.runDueBackups(connectedDeviceIds);
      } catch (err: any) {
        console.warn(`Backup scheduler cycle failed: ${err?.message || err}`);
      }
    } catch (err: any) {
      console.error(`Connection sync cycle failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  private async isDeviceConnected(device: any): Promise<boolean> {
    try {
      const service = new SSHService(buildDeviceSshConfig(device));
      await service.testConnection();
      return true;
    } catch {
      return false;
    }
  }
}

export const connectionSyncService = new ConnectionSyncService();
