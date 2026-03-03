import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 16;

let MASTER_KEY: Buffer | null = null;
let MASTER_SECRET: string | null = null;

function loadMasterSecret(): string {
  const envKey = process.env.APP_MASTER_KEY;
  if (envKey && envKey.trim() !== '') {
    return envKey.trim();
  }

  throw new Error('APP_MASTER_KEY is missing.');
}

function deriveRecordKey(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, 32);
}

export function initEncryption() {
  const key = loadMasterSecret();
  
  if (key.length < 32) {
    throw new Error('APP_MASTER_KEY is too short. It must be at least 32 characters long.');
  }

  MASTER_SECRET = key;
  // Derive a 32-byte key from the input string using SHA-256
  // Legacy key for decrypting old format values.
  MASTER_KEY = crypto.createHash('sha256').update(key).digest();
}

export function encrypt(text: string): string {
  if (!MASTER_KEY || !MASTER_SECRET) initEncryption();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const perRecordKey = deriveRecordKey(MASTER_SECRET!, salt);
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, perRecordKey, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  // v2 format: v2:salt:iv:tag:encrypted
  return `v2:${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decrypt(text: string): string {
  if (!MASTER_KEY || !MASTER_SECRET) initEncryption();

  const parts = text.split(':');

  // New format: v2:salt:iv:tag:encrypted
  if (parts.length === 5 && parts[0] === 'v2') {
    const salt = Buffer.from(parts[1], 'hex');
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const encryptedText = parts[4];
    const perRecordKey = deriveRecordKey(MASTER_SECRET!, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, perRecordKey, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // Legacy format: iv:tag:encrypted
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY!, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
