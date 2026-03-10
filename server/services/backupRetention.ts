import db from '../db.js';
import * as fs from 'fs';
import * as path from 'path';

interface BackupRow {
  id: string;
  device_id: string;
  status: string;
  started_at: string;
  backup_path: string | null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

async function directorySizeBytes(dirPath: string): Promise<number> {
  try {
    const st = await fs.promises.stat(dirPath);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }

  let total = 0;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
      continue;
    }
    if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch {
        // ignore partial race conditions during cleanup
      }
    }
  }
  return total;
}

async function removeBackup(row: BackupRow): Promise<void> {
  if (row.backup_path) {
    await fs.promises.rm(row.backup_path, { recursive: true, force: true });
  }
  db.prepare('DELETE FROM device_backups WHERE id = ?').run(row.id);
}

export async function cleanupBackupsForDevice(deviceId: string): Promise<void> {
  const retentionDays = parsePositiveInt(process.env.BACKUP_RETENTION_DAYS, 30);
  const maxCount = parsePositiveInt(process.env.BACKUP_MAX_COUNT, 20);
  const maxTotalSizeGb = parsePositiveInt(process.env.BACKUP_MAX_TOTAL_SIZE_GB, 20);
  const maxTotalBytes = maxTotalSizeGb * 1024 * 1024 * 1024;

  const rows = db.prepare(`
    SELECT id, device_id, status, started_at, backup_path
    FROM device_backups
    WHERE device_id = ?
    ORDER BY datetime(started_at) DESC
  `).all(deviceId) as BackupRow[];

  const runningIds = new Set(rows.filter((r) => r.status === 'running').map((r) => r.id));
  const nonRunning = rows.filter((r) => !runningIds.has(r.id));
  const protectedIds = new Set(nonRunning.slice(0, 3).map((r) => r.id));

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const byOldest = [...nonRunning].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

  for (const row of byOldest) {
    if (protectedIds.has(row.id)) continue;
    const started = new Date(row.started_at).getTime();
    if (Number.isFinite(started) && started < cutoffMs) {
      await removeBackup(row);
    }
  }

  const afterAge = db.prepare(`
    SELECT id, device_id, status, started_at, backup_path
    FROM device_backups
    WHERE device_id = ? AND status != 'running'
    ORDER BY datetime(started_at) DESC
  `).all(deviceId) as BackupRow[];
  const protectedAfterAge = new Set(afterAge.slice(0, 3).map((r) => r.id));

  const countCandidates = [...afterAge].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  while (countCandidates.length > maxCount) {
    const idx = countCandidates.findIndex((r) => !protectedAfterAge.has(r.id));
    if (idx < 0) break;
    const [victim] = countCandidates.splice(idx, 1);
    await removeBackup(victim);
  }

  const sizeRows = db.prepare(`
    SELECT id, device_id, status, started_at, backup_path
    FROM device_backups
    WHERE device_id = ? AND status != 'running'
    ORDER BY datetime(started_at) DESC
  `).all(deviceId) as BackupRow[];
  const protectedAfterCount = new Set(sizeRows.slice(0, 3).map((r) => r.id));
  const oldestToNewest = [...sizeRows].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

  let totalBytes = 0;
  const sizeMap = new Map<string, number>();
  for (const row of oldestToNewest) {
    const size = row.backup_path ? await directorySizeBytes(row.backup_path) : 0;
    sizeMap.set(row.id, size);
    totalBytes += size;
  }

  for (const row of oldestToNewest) {
    if (totalBytes <= maxTotalBytes) break;
    if (protectedAfterCount.has(row.id)) continue;
    const size = sizeMap.get(row.id) || 0;
    await removeBackup(row);
    totalBytes -= size;
  }
}
