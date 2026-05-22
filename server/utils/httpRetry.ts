// Retry helper for idempotent HTTP reads (CalDAV REPORT, ICS GET).
// Only retries failures that are likely transient:
//   - Network errors with no response (DNS, refused, reset, aborted, timeout)
//   - HTTP 408 (Request Timeout), 429 (Too Many Requests), 5xx
// Auth (401/403), not-found (404), and other 4xx errors fail fast — retrying
// them just delays the real diagnostic.

interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED', // axios timeout
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
]);

export function isTransientHttpError(err: any): boolean {
  if (!err) return false;
  if (typeof err.code === 'string' && TRANSIENT_NET_CODES.has(err.code)) return true;
  const status = err.response?.status;
  if (typeof status !== 'number') {
    // No HTTP response at all → network-layer failure → retryable.
    return true;
  }
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

export async function retryHttpRequest<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 8000;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === attempts - 1;
      if (isLastAttempt || !isTransientHttpError(err)) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      options.onRetry?.(err, attempt + 1, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
