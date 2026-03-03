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
      sync_when_connected INTEGER DEFAULT 0,
      last_connected_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'pdf',
      remote_path TEXT,
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

    CREATE TABLE IF NOT EXISTS calendar_subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      encrypted_url TEXT NOT NULL,
      update_frequency_minutes INTEGER DEFAULT 30,
      enabled INTEGER DEFAULT 1,
      last_fetched_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      last_etag TEXT,
      last_modified TEXT,
      last_body_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_subscriptions (
      document_id TEXT,
      subscription_id TEXT,
      PRIMARY KEY (document_id, subscription_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (subscription_id) REFERENCES calendar_subscriptions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscription_events (
      subscription_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      recurrence_id TEXT NOT NULL DEFAULT '',
      summary TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      location TEXT,
      description TEXT,
      all_day INTEGER DEFAULT 0,
      timezone TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (subscription_id, uid, recurrence_id),
      FOREIGN KEY (subscription_id) REFERENCES calendar_subscriptions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subscription_events_subscription_start
      ON subscription_events(subscription_id, start_at);
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

  const hasSyncEnabled = docsTableInfo.some(col => col.name === 'sync_enabled');
  const hasSyncSchedule = docsTableInfo.some(col => col.name === 'sync_schedule');
  if (hasSyncEnabled || hasSyncSchedule) {
    console.log('Migrating documents: removing deprecated sync_enabled/sync_schedule columns');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
        ALTER TABLE documents RENAME TO documents_old;

        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          type TEXT DEFAULT 'pdf',
          remote_path TEXT,
          last_synced_at TEXT,
          sync_status TEXT DEFAULT 'idle',
          last_error TEXT,
          year INTEGER DEFAULT 2025,
          timezone TEXT DEFAULT 'UTC',
          caldav_account_id TEXT,
          device_id TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (caldav_account_id) REFERENCES caldav_accounts(id),
          FOREIGN KEY (device_id) REFERENCES devices(id)
        );

        INSERT INTO documents (
          id, title, type, remote_path, last_synced_at, sync_status, last_error,
          year, timezone, caldav_account_id, device_id, created_at, updated_at
        )
        SELECT
          id, title, type, remote_path, last_synced_at, sync_status, last_error,
          year, timezone, caldav_account_id, device_id, created_at, updated_at
        FROM documents_old;

        DROP TABLE documents_old;
      `);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  const devicesTableInfo = db.prepare("PRAGMA table_info(devices)").all() as any[];
  const hasSyncWhenConnected = devicesTableInfo.some(col => col.name === 'sync_when_connected');
  if (!hasSyncWhenConnected) {
    console.log('Migrating devices: adding sync_when_connected column');
    db.exec('ALTER TABLE devices ADD COLUMN sync_when_connected INTEGER DEFAULT 0');
  }

  const docsSubTableInfo = db.prepare("PRAGMA table_info(document_subscriptions)").all() as any[];
  if (docsSubTableInfo.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_subscriptions (
        document_id TEXT,
        subscription_id TEXT,
        PRIMARY KEY (document_id, subscription_id),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (subscription_id) REFERENCES calendar_subscriptions(id) ON DELETE CASCADE
      )
    `);
  }

  // Repair stale foreign keys left behind by old migrations where documents table was renamed.
  // If link tables still reference `documents_old`, updates/deletes on documents can fail with:
  // "no such table: main.documents_old"
  const docAccountsFkInfo = db.prepare('PRAGMA foreign_key_list(document_accounts)').all() as any[];
  const docSubsFkInfo = db.prepare('PRAGMA foreign_key_list(document_subscriptions)').all() as any[];
  const hasStaleDocAccountsFk = docAccountsFkInfo.some((row) => row.table === 'documents_old');
  const hasStaleDocSubsFk = docSubsFkInfo.some((row) => row.table === 'documents_old');

  if (hasStaleDocAccountsFk || hasStaleDocSubsFk) {
    console.log('Repairing stale foreign keys: replacing references to documents_old');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      if (hasStaleDocAccountsFk) {
        db.exec(`
          ALTER TABLE document_accounts RENAME TO document_accounts_old_fk;

          CREATE TABLE document_accounts (
            document_id TEXT,
            account_id TEXT,
            PRIMARY KEY (document_id, account_id),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
            FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE
          );

          INSERT INTO document_accounts (document_id, account_id)
          SELECT document_id, account_id
          FROM document_accounts_old_fk;

          DROP TABLE document_accounts_old_fk;
        `);
      }

      if (hasStaleDocSubsFk) {
        db.exec(`
          ALTER TABLE document_subscriptions RENAME TO document_subscriptions_old_fk;

          CREATE TABLE document_subscriptions (
            document_id TEXT,
            subscription_id TEXT,
            PRIMARY KEY (document_id, subscription_id),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
            FOREIGN KEY (subscription_id) REFERENCES calendar_subscriptions(id) ON DELETE CASCADE
          );

          INSERT INTO document_subscriptions (document_id, subscription_id)
          SELECT document_id, subscription_id
          FROM document_subscriptions_old_fk;

          DROP TABLE document_subscriptions_old_fk;
        `);
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Cleanup: Reset stuck syncing status
  db.prepare("UPDATE documents SET sync_status = 'idle' WHERE sync_status = 'syncing'").run();
  
  console.log('Database initialized at', DB_PATH);
}

export default db;
