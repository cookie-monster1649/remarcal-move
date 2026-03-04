const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function parseOptionalBool(value: string | undefined | null): boolean | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

function parseLimit(value: string | undefined | null, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

function parseDayFilter(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

const master = parseOptionalBool(process.env.CALENDAR_TRACE) ?? false;

function resolveFlag(name: string): boolean {
  const explicit = parseOptionalBool(process.env[name]);
  if (explicit !== undefined) return explicit;
  return master;
}

export const traceConfig = {
  master,
  ingest: resolveFlag('CAL_TRACE_INGEST'),
  sync: resolveFlag('CAL_TRACE_SYNC'),
  pdf: resolveFlag('CAL_TRACE_PDF'),
  tzFallback: resolveFlag('CAL_TRACE_TZ_FALLBACK'),
  limit: parseLimit(process.env.CAL_TRACE_LIMIT, 80),
  day: parseDayFilter(process.env.CAL_TRACE_DAY),
};
