import * as fs from 'fs';
import * as path from 'path';

function getDataDir(): string {
  return process.env.DATA_DIR || './data';
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore chmod failures on unsupported filesystems
  }
}

export class SshKeyManager {
  private getSshDir(): string {
    return path.join(getDataDir(), 'ssh');
  }

  private getPrivateKeyPath(deviceId: string): string {
    return path.join(this.getSshDir(), `device-${deviceId}`);
  }

  private getPublicKeyPath(deviceId: string): string {
    return path.join(this.getSshDir(), `device-${deviceId}.pub`);
  }

  hasDevicePrivateKey(deviceId: string): boolean {
    return fs.existsSync(this.getPrivateKeyPath(deviceId));
  }

  loadDevicePrivateKey(deviceId: string): string | undefined {
    const p = this.getPrivateKeyPath(deviceId);
    if (!fs.existsSync(p)) return undefined;
    return fs.readFileSync(p, 'utf8');
  }

  storeDeviceKeyPair(deviceId: string, privateKey: string, publicKey?: string): void {
    const dir = this.getSshDir();
    ensureDir(dir);
    const privateKeyPath = this.getPrivateKeyPath(deviceId);
    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
    try {
      fs.chmodSync(privateKeyPath, 0o600);
    } catch {
      // ignore chmod failures on unsupported filesystems
    }

    if (publicKey) {
      const publicKeyPath = this.getPublicKeyPath(deviceId);
      fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });
    }
  }

  removeDeviceKeys(deviceId: string): void {
    const files = [this.getPrivateKeyPath(deviceId), this.getPublicKeyPath(deviceId)];
    for (const f of files) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export const sshKeyManager = new SshKeyManager();
