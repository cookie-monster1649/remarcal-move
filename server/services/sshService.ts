import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SSHConfig {
  host: string;
  username: string; // usually 'root'
  privateKey?: string; // PEM format
  passphrase?: string;
  password?: string;
}

export interface DeviceFile {
  uuid: string;
  name: string;
  lastModified: Date;
}

export class SSHService {
  private config: SSHConfig;

  constructor(config: SSHConfig) {
    this.config = config;
  }

  private async connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => resolve(conn))
          .on('error', (err) => reject(err))
          .connect({
            host: this.config.host,
            port: 22,
            username: this.config.username,
            privateKey: this.config.privateKey,
            passphrase: this.config.passphrase,
            password: this.config.password,
            // Strict host checking requires known_hosts management. 
            // For this MVP, we'll accept new keys but warn (or implement a simple trust-on-first-use if needed).
            // In a real app, we'd persist known_hosts.
            // For now, we'll disable strict checking to ensure connectivity in this demo environment, 
            // but in production code we'd verify the host key.
            readyTimeout: 20000,
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

          // Filter for .metadata files
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

            // Read metadata content to get the display name
            sftp.readFile(metadataPath, (err, buffer) => {
              if (!err) {
                try {
                  const meta = JSON.parse(buffer.toString());
                  // Only include if it's a PDF-backed document (optional check, but good for safety)
                  // Actually, we might want to overwrite notebooks too if they are just PDFs underneath?
                  // Usually we look for "visibleName".
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

  async backupDocument(uuid: string, backupDir: string): Promise<string> {
    const conn = await this.connect();
    const basePath = '/home/root/.local/share/remarkable/xochitl/';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const specificBackupDir = path.join(backupDir, `${uuid}_${timestamp}`);

    if (!fs.existsSync(specificBackupDir)) {
      fs.mkdirSync(specificBackupDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        const filesToBackup = [
          `${uuid}.content`,
          `${uuid}.pagedata`,
          `${uuid}.pdf`, // The original PDF
          `${uuid}.metadata`
        ];

        let completed = 0;
        let hasError = false;

        // 1. Backup metadata files
        const backupFile = (filename: string, cb: () => void) => {
            const remotePath = path.join(basePath, filename);
            const localPath = path.join(specificBackupDir, filename);
            
            sftp.fastGet(remotePath, localPath, (err) => {
                if (err) {
                    // It's possible .pdf doesn't exist if it's a notebook, but we expect it for PDF replacement workflow.
                    console.warn(`Failed to backup ${filename}: ${err.message}`);
                }
                cb();
            });
        };

        // 2. Backup strokes directory (recursively? sftp doesn't do recursive easily)
        // For MVP, let's just backup the main files. Backing up the directory requires listing it and downloading each file.
        // Let's implement directory backup.
        const backupStrokes = (cb: () => void) => {
            const remoteDir = path.join(basePath, uuid);
            const localDir = path.join(specificBackupDir, uuid);
            
            if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);

            sftp.readdir(remoteDir, (err, list) => {
                if (err) {
                    // Directory might not exist if no strokes
                    cb();
                    return;
                }

                let fileCount = 0;
                if (list.length === 0) {
                    cb();
                    return;
                }

                list.forEach(f => {
                    sftp.fastGet(path.join(remoteDir, f.filename), path.join(localDir, f.filename), (err) => {
                        fileCount++;
                        if (fileCount === list.length) cb();
                    });
                });
            });
        };

        // Execute backups
        let pending = filesToBackup.length + 1; // +1 for strokes dir
        const checkDone = () => {
            pending--;
            if (pending === 0) {
                conn.end();
                resolve(specificBackupDir);
            }
        };

        filesToBackup.forEach(f => backupFile(f, checkDone));
        backupStrokes(checkDone);
      });
    });
  }

  async uploadPDF(uuid: string, localPdfPath: string): Promise<void> {
    const conn = await this.connect();
    const remotePath = `/home/root/.local/share/remarkable/xochitl/${uuid}.pdf`;

    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
            conn.end();
            return reject(err);
        }

        sftp.fastPut(localPdfPath, remotePath, (err) => {
            conn.end();
            if (err) reject(err);
            else resolve();
        });
      });
    });
  }
  
  // Helper to validate PDF page count match (requires reading .content file)
  async validatePageCount(uuid: string, newPdfPageCount: number): Promise<boolean> {
      const conn = await this.connect();
      const remoteContentPath = `/home/root/.local/share/remarkable/xochitl/${uuid}.content`;
      
      return new Promise((resolve, reject) => {
          conn.sftp((err, sftp) => {
              if (err) {
                  conn.end();
                  return reject(err);
              }
              
              sftp.readFile(remoteContentPath, (err, buffer) => {
                  conn.end();
                  if (err) return reject(err);
                  
                  try {
                      const content = JSON.parse(buffer.toString());
                      // .content file has "pages" array or "pageCount"
                      // Usually "pages": ["uuid", "uuid", ...]
                      const existingPages = content.pages ? content.pages.length : (content.pageCount || 0);
                      
                      // Check if match
                      // Note: We might allow new PDF to have MORE pages, but definitely not fewer if we want to preserve strokes on later pages.
                      // Strict equality is safest for "update in place".
                      resolve(existingPages === newPdfPageCount);
                  } catch (e) {
                      reject(e);
                  }
              });
          });
      });
  }

  async restoreDocument(uuid: string, backupDir: string): Promise<void> {
      const conn = await this.connect();
      const basePath = '/home/root/.local/share/remarkable/xochitl/';
      const pdfPath = path.join(backupDir, `${uuid}.pdf`);
      
      if (!fs.existsSync(pdfPath)) {
          conn.end();
          throw new Error('Backup PDF not found');
      }

      return new Promise((resolve, reject) => {
          conn.sftp((err, sftp) => {
              if (err) {
                  conn.end();
                  return reject(err);
              }
              
              sftp.fastPut(pdfPath, path.join(basePath, `${uuid}.pdf`), (err) => {
                  conn.end();
                  if (err) reject(err);
                  else resolve();
              });
          });
      });
  }
}
