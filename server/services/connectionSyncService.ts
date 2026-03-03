import db from '../db.js';
import { decrypt } from './encryptionService.js';
import { SSHService } from './sshService.js';
import { SyncService } from './syncService.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

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
    console.log('Connection sync service started (poll every 5 minutes)');
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
        .prepare('SELECT * FROM devices WHERE sync_when_connected = 1')
        .all() as any[];

      for (const device of devices) {
        const isConnected = await this.isDeviceConnected(device);
        if (!isConnected) {
          continue;
        }

        db.prepare('UPDATE devices SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), device.id);

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
    } catch (err: any) {
      console.error(`Connection sync cycle failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  private async isDeviceConnected(device: any): Promise<boolean> {
    try {
      const service = new SSHService({
        host: device.host,
        username: device.username,
        port: device.port,
        password: device.encrypted_password ? decrypt(device.encrypted_password) : undefined,
        readyTimeout: 5000,
      });
      await service.testConnection();
      return true;
    } catch {
      return false;
    }
  }
}

export const connectionSyncService = new ConnectionSyncService();
