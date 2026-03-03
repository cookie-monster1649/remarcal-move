import { Client, utils as sshUtils } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SSHConfig {
  host: string;
  username: string;
  password?: string;
  privateKey?: string;
  hostKeyFingerprint?: string;
  trustOnFirstUse?: boolean;
  port?: number;
  readyTimeout?: number;
}

export interface DeviceFile {
  uuid: string;
  name: string;
  lastModified: Date;
}

export class SSHService {
  private config: SSHConfig;
  private observedHostKeyFingerprint: string | null = null;

  constructor(config: SSHConfig) {
    this.config = config;
  }

  static generateKeyPair(comment = 'remarcal-device-key'): { publicKey: string; privateKey: string } {
    const keys = (sshUtils as any).generateKeyPairSync('ed25519', { comment });
    return {
      publicKey: keys.public,
      privateKey: keys.private,
    };
  }

  getObservedHostKeyFingerprint(): string | null {
    return this.observedHostKeyFingerprint;
  }

  private getConfig() {
    if (!this.config.host || !this.config.username) {
      throw new Error('SSH Host and username are required');
    }
    return {
      host: this.config.host,
      port: this.config.port || 22,
      username: this.config.username,
      password: this.config.password,
      privateKey: this.config.privateKey,
      hostKeyFingerprint: this.config.hostKeyFingerprint,
      trustOnFirstUse: this.config.trustOnFirstUse !== false,
      readyTimeout: this.config.readyTimeout || 20000,
    };
  }

  async testConnection(): Promise<void> {
    const conn = await this.connect();
    conn.end();
  }

  private async connect(): Promise<Client> {
    const config = this.getConfig();
    if (!config.password && !config.privateKey) {
      throw new Error('No SSH authentication configured. Provide password or private key.');
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const sshConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.readyTimeout,
        tryKeyboard: false,
        hostHash: 'sha256',
        hostVerifier: (hash: string) => {
          const presented = `sha256:${hash}`;
          this.observedHostKeyFingerprint = presented;
          if (config.hostKeyFingerprint && config.hostKeyFingerprint.trim() !== '') {
            return presented === config.hostKeyFingerprint.trim();
          }
          return !!config.trustOnFirstUse;
        },
      };

      if (config.privateKey) sshConfig.privateKey = config.privateKey;
      if (config.password) sshConfig.password = config.password;

      conn.on('ready', () => resolve(conn))
        .on('error', (err) => reject(err))
        .connect(sshConfig);
    });
  }

  private async execCommand(conn: Client, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        stream.on('close', (code: number | undefined) => {
          if (code && code !== 0) return reject(new Error(stderr || `Remote command failed (${code})`));
          resolve(stdout);
        });
      });
    });
  }

  private shellEscapeSingleArg(arg: string): string {
    return `'${arg.replace(/'/g, `'"'"'`)}'`;
  }

  async installPublicKey(publicKey: string): Promise<void> {
    const conn = await this.connect();
    try {
      await this.execCommand(conn, 'mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh');
      const escaped = this.shellEscapeSingleArg(publicKey.trim());
      await this.execCommand(conn, `grep -qxF ${escaped} /home/root/.ssh/authorized_keys 2>/dev/null || echo ${escaped} >> /home/root/.ssh/authorized_keys`);
      await this.execCommand(conn, 'chmod 600 /home/root/.ssh/authorized_keys');
    } finally {
      conn.end();
    }
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

        sftp.readdir(basePath, (readErr, list) => {
          if (readErr) {
            conn.end();
            return reject(readErr);
          }

          const metadataFiles = list.filter((f) => f.filename.endsWith('.metadata'));
          const documents: DeviceFile[] = [];
          let processed = 0;

          if (metadataFiles.length === 0) {
            conn.end();
            resolve([]);
            return;
          }

          metadataFiles.forEach((file) => {
            const uuid = file.filename.replace('.metadata', '');
            const metadataPath = path.join(basePath, file.filename);

            sftp.readFile(metadataPath, (fileErr, buffer) => {
              if (!fileErr) {
                try {
                  const meta = JSON.parse(buffer.toString());
                  if (meta.visibleName) {
                    documents.push({
                      uuid,
                      name: meta.visibleName,
                      lastModified: new Date(parseInt(meta.lastModified, 10)),
                    });
                  }
                } catch {
                  // ignore malformed metadata
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
            sftp.fastPut(local, remote, (putErr) => {
              if (putErr) rej(putErr);
              else res();
            });
          });
        };

        const runUpload = async () => {
          try {
            await uploadFile(localPdfPath, tempPath);

            const localHash = crypto.createHash('sha256').update(fs.readFileSync(localPdfPath)).digest('hex');
            const remoteHash = await new Promise<string>((res, rej) => {
              conn.exec(`sha256sum ${tempPath}`, (execErr, stream) => {
                if (execErr) return rej(execErr);
                let output = '';
                stream.on('data', (data: Buffer) => {
                  output += data.toString();
                });
                stream.on('close', () => res(output.split(' ')[0]));
              });
            });

            if (remoteHash !== localHash) {
              throw new Error(`Hash mismatch: Local ${localHash} vs Remote ${remoteHash}`);
            }

            let isFirstSync = false;
            if (isXochitl) {
              const metaRemotePath = path.join(dirName, `${baseName}.metadata`);
              isFirstSync = await new Promise<boolean>((res) => {
                sftp.stat(metaRemotePath, (statErr) => res(!!statErr));
              });

              const now = Date.now().toString();
              const metadata = {
                deleted: false,
                lastModified: now,
                metadatamodified: false,
                modified: false,
                parent: '',
                pinned: false,
                synced: false,
                type: 'DocumentType',
                visibleName: visibleName || baseName,
              };
              const content = {
                extraMetadata: {},
                fileType: 'pdf',
                fontName: '',
                lineHeight: -1,
                margins: 100,
                orientation: 'portrait',
                pageCount: 0,
                textScale: 1,
                transform: { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 },
              };

              const metaLocal = path.join(path.dirname(localPdfPath), `${baseName}.metadata`);
              const contentLocal = path.join(path.dirname(localPdfPath), `${baseName}.content`);

              fs.writeFileSync(metaLocal, JSON.stringify(metadata));
              fs.writeFileSync(contentLocal, JSON.stringify(content));

              await uploadFile(metaLocal, metaRemotePath);
              await uploadFile(contentLocal, path.join(dirName, `${baseName}.content`));
            }

            if (backupEnabled) {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const backupPath = `${remotePath}.bak.${timestamp}`;
              await new Promise<void>((res) => {
                sftp.stat(remotePath, (statErr) => {
                  if (!statErr) sftp.rename(remotePath, backupPath, () => res());
                  else res();
                });
              });
            }

            await new Promise<void>((res, rej) => {
              sftp.rename(tempPath, remotePath, (renameErr) => {
                if (renameErr) rej(renameErr);
                else res();
              });
            });

            if (isXochitl && isFirstSync) {
              await new Promise<void>((res) => {
                conn.exec('systemctl restart xochitl', (restartErr, stream) => {
                  if (restartErr) console.warn('Failed to restart xochitl:', restartErr);
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

        void runUpload();
      });
    });
  }
}
