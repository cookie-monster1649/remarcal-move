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
// Enforce foreign key constraints (required in SQLite; off by default)
db.pragma('foreign_keys = ON');

export function initDb() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS caldav_accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      selected_calendars TEXT, -- JSON array of {url, name}
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      last_connected_at TEXT,
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
      year INTEGER DEFAULT 2025,
      timezone TEXT DEFAULT 'UTC',
      caldav_account_id TEXT,
      device_id TEXT, -- Link to device
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (caldav_account_id) REFERENCES caldav_accounts(id),
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS document_accounts (
      document_id TEXT,
      account_id TEXT,
      PRIMARY KEY (document_id, account_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE
    );
  `);

  // Migrations: Add columns if they don't exist
  const caldavTableInfo = db.prepare("PRAGMA table_info(caldav_accounts)").all() as any[];
  const hasSelectedCalendars = caldavTableInfo.some(col => col.name === 'selected_calendars');
  if (!hasSelectedCalendars) {
    console.log('Migrating caldav_accounts: adding selected_calendars column');
    db.exec('ALTER TABLE caldav_accounts ADD COLUMN selected_calendars TEXT');
  }

  const docsTableInfo = db.prepare("PRAGMA table_info(documents)").all() as any[];
  const hasYear = docsTableInfo.some(col => col.name === 'year');
  if (!hasYear) {
    console.log('Migrating documents: adding year column');
    db.exec('ALTER TABLE documents ADD COLUMN year INTEGER DEFAULT 2025');
  }

  const hasTimezone = docsTableInfo.some(col => col.name === 'timezone');
  if (!hasTimezone) {
    console.log('Migrating documents: adding timezone column');
    db.exec("ALTER TABLE documents ADD COLUMN timezone TEXT DEFAULT 'UTC'");
  }

  // Cleanup: Reset stuck syncing status
  db.prepare("UPDATE documents SET sync_status = 'idle' WHERE sync_status = 'syncing'").run();
  
  console.log('Database initialized at', DB_PATH);
}

export default db;
