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
      encrypted_password TEXT,
      auth_mode TEXT DEFAULT 'password', -- password | key
      encrypted_private_key TEXT,
      public_key TEXT,
      host_key_fingerprint TEXT,
      allow_password_fallback INTEGER DEFAULT 1,
      backup_enabled INTEGER DEFAULT 0,
      backup_frequency_hours INTEGER DEFAULT 24,
      last_backup_at TEXT,
      port INTEGER DEFAULT 22,
      sync_when_connected INTEGER DEFAULT 0,
      last_connected_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS device_backups (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      backup_path TEXT,
      doc_count INTEGER DEFAULT 0,
      byte_count INTEGER DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_device_backups_device_started
      ON device_backups(device_id, started_at DESC);

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
      owner_email TEXT,
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
      participation_status TEXT,
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

  const hasAuthMode = devicesTableInfo.some(col => col.name === 'auth_mode');
  if (!hasAuthMode) {
    console.log('Migrating devices: adding auth_mode column');
    db.exec("ALTER TABLE devices ADD COLUMN auth_mode TEXT DEFAULT 'password'");
  }

  const hasEncryptedPrivateKey = devicesTableInfo.some(col => col.name === 'encrypted_private_key');
  if (!hasEncryptedPrivateKey) {
    console.log('Migrating devices: adding encrypted_private_key column');
    db.exec('ALTER TABLE devices ADD COLUMN encrypted_private_key TEXT');
  }

  const hasPublicKey = devicesTableInfo.some(col => col.name === 'public_key');
  if (!hasPublicKey) {
    console.log('Migrating devices: adding public_key column');
    db.exec('ALTER TABLE devices ADD COLUMN public_key TEXT');
  }

  const hasHostKeyFingerprint = devicesTableInfo.some(col => col.name === 'host_key_fingerprint');
  if (!hasHostKeyFingerprint) {
    console.log('Migrating devices: adding host_key_fingerprint column');
    db.exec('ALTER TABLE devices ADD COLUMN host_key_fingerprint TEXT');
  }

  const hasAllowPasswordFallback = devicesTableInfo.some(col => col.name === 'allow_password_fallback');
  if (!hasAllowPasswordFallback) {
    console.log('Migrating devices: adding allow_password_fallback column');
    db.exec('ALTER TABLE devices ADD COLUMN allow_password_fallback INTEGER DEFAULT 1');
  }

  const hasBackupEnabled = devicesTableInfo.some(col => col.name === 'backup_enabled');
  if (!hasBackupEnabled) {
    console.log('Migrating devices: adding backup_enabled column');
    db.exec('ALTER TABLE devices ADD COLUMN backup_enabled INTEGER DEFAULT 0');
  }

  const hasBackupFrequencyHours = devicesTableInfo.some(col => col.name === 'backup_frequency_hours');
  if (!hasBackupFrequencyHours) {
    console.log('Migrating devices: adding backup_frequency_hours column');
    db.exec('ALTER TABLE devices ADD COLUMN backup_frequency_hours INTEGER DEFAULT 24');
  }

  const hasLastBackupAt = devicesTableInfo.some(col => col.name === 'last_backup_at');
  if (!hasLastBackupAt) {
    console.log('Migrating devices: adding last_backup_at column');
    db.exec('ALTER TABLE devices ADD COLUMN last_backup_at TEXT');
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

  const subscriptionEventsTableInfo = db.prepare("PRAGMA table_info(subscription_events)").all() as any[];
  const hasParticipationStatus = subscriptionEventsTableInfo.some(col => col.name === 'participation_status');
  if (!hasParticipationStatus) {
    console.log('Migrating subscription_events: adding participation_status column');
    db.exec('ALTER TABLE subscription_events ADD COLUMN participation_status TEXT');
  }

  const subscriptionsTableInfo = db.prepare("PRAGMA table_info(calendar_subscriptions)").all() as any[];
  const hasSubscriptionOwnerEmail = subscriptionsTableInfo.some(col => col.name === 'owner_email');
  if (!hasSubscriptionOwnerEmail) {
    console.log('Migrating calendar_subscriptions: adding owner_email column');
    db.exec('ALTER TABLE calendar_subscriptions ADD COLUMN owner_email TEXT');
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

  // Cleanup: Reset transient in-progress statuses left by crashes/restarts.
  db.prepare("UPDATE documents SET sync_status = 'idle' WHERE sync_status IN ('syncing', 'checking')").run();
  
  console.log('Database initialized at', DB_PATH);
}

export default db;
