import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;

let MASTER_KEY: Buffer | null = null;

export function initEncryption() {
  const key = process.env.APP_MASTER_KEY;
  if (!key) {
    throw new Error('APP_MASTER_KEY environment variable is missing. Application cannot start.');
  }
  
  if (key.length < 32) {
    throw new Error('APP_MASTER_KEY is too short. It must be at least 32 characters long.');
  }

  // Derive a 32-byte key from the input string using SHA-256
  // This allows the user to provide a long passphrase or a random string.
  MASTER_KEY = crypto.createHash('sha256').update(key).digest();
}

export function encrypt(text: string): string {
  if (!MASTER_KEY) initEncryption();
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY!, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  // Format: iv:tag:encrypted
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decrypt(text: string): string {
  if (!MASTER_KEY) initEncryption();
  
  const parts = text.split(':');
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
