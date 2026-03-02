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

  async uploadPDF(remotePath: string, localPdfPath: string, visibleName?: string): Promise<void> {
    const isDryRun = process.env.SYNC_DRY_RUN === 'true';
    if (isDryRun) {
        console.log(`[DRY RUN] Would upload ${localPdfPath} to ${remotePath}`);
        return;
    }

    const conn = await this.connect();
    const tempPath = `${remotePath}.tmp`;
    const backupEnabled = process.env.SYNC_BACKUP_REMOTE === 'true';

    // Determine if this is a reMarkable xochitl upload
    const isXochitl = remotePath.includes('/remarkable/xochitl/');
    const baseName = path.basename(remotePath, '.pdf');
    const dirName = path.dirname(remotePath);

    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
            conn.end();
            return reject(err);
        }

        const uploadFile = (local: string, remote: string) => {
            return new Promise<void>((res, rej) => {
                sftp.fastPut(local, remote, (err) => {
                    if (err) rej(err);
                    else res();
                });
            });
        };

        const runUpload = async () => {
            try {
                // 1. Upload PDF
                await uploadFile(localPdfPath, tempPath);

                // 2. Verify Hash
                const localHash = crypto.createHash('sha256').update(fs.readFileSync(localPdfPath)).digest('hex');
                const remoteHash = await new Promise<string>((res, rej) => {
                    conn.exec(`sha256sum ${tempPath}`, (err, stream) => {
                        if (err) return rej(err);
                        let output = '';
                        stream.on('data', (data: any) => output += data.toString());
                        stream.on('close', () => res(output.split(' ')[0]));
                    });
                });

                if (remoteHash !== localHash) {
                    throw new Error(`Hash mismatch: Local ${localHash} vs Remote ${remoteHash}`);
                }

                // 3. Handle Metadata and Content if xochitl
                if (isXochitl) {
                    const now = Date.now().toString();
                    const metadata = {
                        deleted: false,
                        lastModified: now,
                        metadatamodified: false,
                        modified: false,
                        parent: "",
                        pinned: false,
                        synced: false,
                        type: "DocumentType",
                        visibleName: visibleName || baseName
                    };
                    const content = {
                        extraMetadata: {},
                        fileType: "pdf",
                        fontName: "",
                        lineHeight: -1,
                        margins: 100,
                        orientation: "portrait",
                        pageCount: 0,
                        textScale: 1,
                        transform: { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 }
                    };

                    const metaLocal = path.join(path.dirname(localPdfPath), `${baseName}.metadata`);
                    const contentLocal = path.join(path.dirname(localPdfPath), `${baseName}.content`);
                    
                    fs.writeFileSync(metaLocal, JSON.stringify(metadata));
                    fs.writeFileSync(contentLocal, JSON.stringify(content));

                    await uploadFile(metaLocal, path.join(dirName, `${baseName}.metadata`));
                    await uploadFile(contentLocal, path.join(dirName, `${baseName}.content`));
                }

                // 4. Rename PDF
                if (backupEnabled) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const backupPath = `${remotePath}.bak.${timestamp}`;
                    await new Promise<void>((res) => {
                        sftp.stat(remotePath, (err) => {
                            if (!err) {
                                sftp.rename(remotePath, backupPath, () => res());
                            } else {
                                res();
                            }
                        });
                    });
                }

                await new Promise<void>((res, rej) => {
                    sftp.rename(tempPath, remotePath, (err) => {
                        if (err) rej(err);
                        else res();
                    });
                });

                // 5. Restart xochitl to refresh UI
                if (isXochitl) {
                    await new Promise<void>((res) => {
                        conn.exec('systemctl restart xochitl', (err, stream) => {
                            if (err) console.warn('Failed to restart xochitl:', err);
                            stream?.on('close', () => res());
                            if (!stream) res();
                        });
                    });
                }

                resolve();
            } catch (e) {
                reject(e);
            } finally {
                conn.end();
            }
        };

        runUpload();
      });
    });
  }
}
