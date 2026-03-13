import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface BackupManifestDocument {
  uuid: string;
  visibleName: string;
  type: 'pdf' | 'notebook' | 'epub';
  parent: string | null;
  files: string[];
  hasPdf: boolean;
  sha256: Record<string, string>;
}

export interface BackupManifest {
  backupId: string;
  deviceId: string;
  timestamp: string;
  appVersion: string;
  stats: {
    totalFiles: number;
    totalBytes: number;
    documentCount: number;
  };
  documents: BackupManifestDocument[];
  fileIndex?: Record<string, { size: number; mtimeMs: number; sha256: string }>;
  errors?: string[];
}

export interface BackupManifestBuildResult {
  manifest: BackupManifest;
  hadErrors: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizePosix(filePath: string) {
  return filePath.split(path.sep).join('/');
}

async function walkFiles(rootDir: string, relativeDir = ''): Promise<string[]> {
  const absDir = path.join(rootDir, relativeDir);
  const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(rootDir, rel));
      continue;
    }
    if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files;
}

export async function streamSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function inferDocType(files: string[]): 'pdf' | 'notebook' | 'epub' {
  if (files.some((f) => f.endsWith('.epub'))) return 'epub';
  if (files.some((f) => f.endsWith('.pdf'))) return 'pdf';
  return 'notebook';
}

function extractUuidFromTopLevel(topLevelName: string): string | null {
  if (UUID_RE.test(topLevelName)) return topLevelName;
  const dotIdx = topLevelName.indexOf('.');
  if (dotIdx > 0) {
    const maybeUuid = topLevelName.slice(0, dotIdx);
    if (UUID_RE.test(maybeUuid)) return maybeUuid;
  }
  return null;
}

export async function buildBackupManifest(
  backupId: string,
  deviceId: string,
  timestamp: string,
  appVersion: string,
  xochitlDir: string,
  concurrencyLimit = 4,
  previousManifest?: BackupManifest | null,
): Promise<BackupManifestBuildResult> {
  const allFiles = await walkFiles(xochitlDir);
  const allFilesPosix = allFiles.map((f) => normalizePosix(f));
  const docsMap = new Map<string, string[]>();
  const statByFile = new Map<string, { size: number; mtimeMs: number }>();
  const errors: string[] = [];
  let totalBytes = 0;

  for (const relFile of allFilesPosix) {
    const absPath = path.join(xochitlDir, relFile);
    try {
      const stat = await fs.promises.stat(absPath);
      totalBytes += stat.size;
      statByFile.set(relFile, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (err: any) {
      errors.push(`stat failed for ${relFile}: ${err?.message || String(err)}`);
    }

    const topLevel = relFile.split('/')[0];
    const uuid = extractUuidFromTopLevel(topLevel);
    if (!uuid) continue;
    const list = docsMap.get(uuid) || [];
    list.push(relFile);
    docsMap.set(uuid, list);
  }

  const prevIndex = previousManifest?.fileIndex || {};
  const checksumTasks: Array<{ rel: string; abs: string }> = [];
  const checksums = new Map<string, string>();

  for (const rel of allFilesPosix) {
    const stat = statByFile.get(rel);
    const prev = prevIndex[rel];
    if (stat && prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && typeof prev.sha256 === 'string') {
      checksums.set(rel, prev.sha256);
      continue;
    }
    checksumTasks.push({ rel, abs: path.join(xochitlDir, rel) });
  }

  let idx = 0;
  const workerCount = Math.max(1, Math.min(concurrencyLimit, 16));
  const workers = Array.from({ length: workerCount }, async () => {
    while (idx < checksumTasks.length) {
      const current = checksumTasks[idx++];
      try {
        const digest = await streamSha256(current.abs);
        checksums.set(current.rel, digest);
      } catch (err: any) {
        errors.push(`sha256 failed for ${current.rel}: ${err?.message || String(err)}`);
      }
    }
  });

  await Promise.all(workers);

  const documents: BackupManifestDocument[] = [];
  for (const [uuid, files] of docsMap.entries()) {
    const metadataFile = `${uuid}.metadata`;
    let visibleName = uuid;
    let parent: string | null = null;
    let type: 'pdf' | 'notebook' | 'epub' = inferDocType(files);

    if (allFilesPosix.includes(metadataFile)) {
      try {
        const raw = await fs.promises.readFile(path.join(xochitlDir, metadataFile), 'utf8');
        const meta = JSON.parse(raw);
        if (typeof meta.visibleName === 'string' && meta.visibleName.trim() !== '') {
          visibleName = meta.visibleName;
        }
        if (typeof meta.parent === 'string' && meta.parent.trim() !== '') {
          parent = meta.parent;
        }
        if (meta.type === 'epub') type = 'epub';
      } catch (err: any) {
        errors.push(`metadata parse failed for ${metadataFile}: ${err?.message || String(err)}`);
      }
    }

    const sortedFiles = Array.from(new Set(files)).sort();
    const sha256: Record<string, string> = {};
    for (const rel of sortedFiles) {
      const digest = checksums.get(rel);
      if (digest) sha256[rel] = digest;
    }

    documents.push({
      uuid,
      visibleName,
      type,
      parent,
      files: sortedFiles,
      hasPdf: sortedFiles.some((f) => f.endsWith('.pdf')),
      sha256,
    });
  }

  documents.sort((a, b) => a.visibleName.localeCompare(b.visibleName));

  const fileIndex: Record<string, { size: number; mtimeMs: number; sha256: string }> = {};
  for (const rel of allFilesPosix) {
    const stat = statByFile.get(rel);
    const sha256 = checksums.get(rel);
    if (!stat || !sha256) continue;
    fileIndex[rel] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256,
    };
  }

  return {
    manifest: {
      backupId,
      deviceId,
      timestamp,
      appVersion,
      stats: {
        totalFiles: allFilesPosix.length,
        totalBytes,
        documentCount: documents.length,
      },
      documents,
      fileIndex,
      ...(errors.length > 0 ? { errors } : {}),
    },
    hadErrors: errors.length > 0,
  };
}
