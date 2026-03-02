import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SSHConfig {
  host?: string;
  username?: string;
  password?: string;
  port?: number; // Add port
}

export interface DeviceFile {
  uuid: string;
  name: string;
  lastModified: Date;
}

// ...

export class SSHService {
  private config: SSHConfig;

  constructor(config: SSHConfig = {}) {
    this.config = config;
  }

  private getConfig() {
    // Prioritize config (DB) over env vars
    return {
      host: this.config.host || process.env.REMARKABLE_HOST,
      port: this.config.port || parseInt(process.env.REMARKABLE_PORT || '22', 10),
      username: this.config.username || process.env.REMARKABLE_USER || 'root',
      password: this.config.password || process.env.REMARKABLE_PASSWORD,
    };
  }

  // Add testConnection method
  async testConnection(): Promise<void> {
    const conn = await this.connect();
    conn.end();
  }

  private async connect(): Promise<Client> {
// ...
    const config = this.getConfig();
    if (!config.host) throw new Error('SSH Host not configured');

    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => resolve(conn))
          .on('error', (err) => reject(err))
          .connect({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            readyTimeout: 20000,
            tryKeyboard: true,
          });
    });
  }

  async listDocuments(): Promise<DeviceFile[]> {
    const conn = await this.connect();
    const basePath = '/home/root/.local/share/remarkable/xochitl/';

    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        sftp.readdir(basePath, (err, list) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          const metadataFiles = list.filter(f => f.filename.endsWith('.metadata'));
          const documents: DeviceFile[] = [];
          let processed = 0;

          if (metadataFiles.length === 0) {
            conn.end();
            resolve([]);
            return;
          }

          metadataFiles.forEach(file => {
            const uuid = file.filename.replace('.metadata', '');
            const metadataPath = path.join(basePath, file.filename);

            sftp.readFile(metadataPath, (err, buffer) => {
              if (!err) {
                try {
                  const meta = JSON.parse(buffer.toString());
                  if (meta.visibleName) {
                     documents.push({
                       uuid,
                       name: meta.visibleName,
                       lastModified: new Date(parseInt(meta.lastModified, 10))
                     });
                  }
                } catch (e) {
                  // Ignore malformed metadata
                }
              }
              
              processed++;
              if (processed === metadataFiles.length) {
                conn.end();
                resolve(documents);
              }
            });
          });
        });
      });
    });
  }

  async uploadPDF(remotePath: string, localPdfPath: string): Promise<void> {
    const isDryRun = process.env.SYNC_DRY_RUN === 'true';
    if (isDryRun) {
        console.log(`[DRY RUN] Would upload ${localPdfPath} to ${remotePath}`);
        return;
    }

    const conn = await this.connect();
    const tempPath = `${remotePath}.tmp`;
    const backupEnabled = process.env.SYNC_BACKUP_REMOTE === 'true';

    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
            conn.end();
            return reject(err);
        }

        // 1. Upload to temp file
        sftp.fastPut(localPdfPath, tempPath, (err) => {
            if (err) {
                conn.end();
                return reject(err);
            }

            // 2. Verify (Size check for simplicity, hash would require reading back or running sha256sum on remote)
            const localHash = crypto.createHash('sha256').update(fs.readFileSync(localPdfPath)).digest('hex');

            conn.exec(`sha256sum ${tempPath}`, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                let output = '';
                stream.on('data', (data: any) => output += data.toString());
                stream.on('close', () => {
                    const remoteHash = output.split(' ')[0];
                    if (remoteHash !== localHash) {
                        conn.end();
                        return reject(new Error(`Hash mismatch: Local ${localHash} vs Remote ${remoteHash}`));
                    }

                    // 3. Optional Backup
                    const doRename = () => {
                        sftp.rename(tempPath, remotePath, (err) => {
                            conn.end();
                            if (err) reject(err);
                            else resolve();
                        });
                    };

                    if (backupEnabled) {
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const backupPath = `${remotePath}.bak.${timestamp}`;
                        // Check if remote file exists first
                        sftp.stat(remotePath, (err, stats) => {
                            if (!err && stats) {
                                sftp.rename(remotePath, backupPath, (err) => {
                                    if (err) console.warn('Backup failed, proceeding with overwrite:', err);
                                    doRename();
                                });
                            } else {
                                doRename();
                            }
                        });
                    } else {
                        doRename();
                    }
                });
            });
        });
      });
    });
  }
}
