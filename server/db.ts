import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || './data';
const DB_PATH = path.join(DATA_DIR, 'app.db');

// Ensure data directory and subdirectories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(DATA_DIR, 'docs'))) {
  fs.mkdirSync(path.join(DATA_DIR, 'docs'), { recursive: true });
}
if (!fs.existsSync(path.join(DATA_DIR, 'logs'))) {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

export function initDb() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS caldav_accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      calendar_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'pdf',
      remote_path TEXT,
      sync_enabled INTEGER DEFAULT 0,
      sync_schedule TEXT, -- Cron expression or similar
      last_synced_at TEXT,
      sync_status TEXT DEFAULT 'idle', -- idle, checking, syncing, error
      last_error TEXT,
      caldav_account_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (caldav_account_id) REFERENCES caldav_accounts(id)
    );
  `);
  
  console.log('Database initialized at', DB_PATH);
}

export default db;
