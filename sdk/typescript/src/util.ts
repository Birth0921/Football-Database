/** Small helpers shared by the client. No runtime dependencies. */

/** Numeric-looking string (PostgreSQL numeric/bigint come back as strings). */
const NUMERIC_STRING = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Recursively convert numeric strings to numbers.
 *
 * PostgreSQL serves `bigint`/`numeric` as JSON strings (`"1.333"`), which is
 * awkward in model code. Keys in `skip` are left untouched (handy for values
 * where leading zeros or exact formatting matter).
 */
export function coerceNumbers<T>(value: T, skip: ReadonlySet<string> = new Set()): T {
  return walk(value, skip) as T;
}

function walk(value: unknown, skip: ReadonlySet<string>, key?: string): unknown {
  if (typeof value === 'string') {
    if (key !== undefined && skip.has(key)) return value;
    if (NUMERIC_STRING.test(value) && value.length < 18) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, skip));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, skip, k);
    }
    return out;
  }
  return value;
}

/** Build a query string, dropping undefined/null/empty values. */
export function toQuery(params: object = {}): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

/** Exponential backoff with full jitter, capped at `capMs`. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** True when the key looks like a platform key (`pf_live_<hex>_<secret>`). */
export function looksLikePlatformKey(key: string): boolean {
  return /^pf_live_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

/**
 * Redact a key for logs: `pf_live_2931b802d8be_****` (prefix only — the
 * lookup handle is safe to log, the secret half never is).
 */
export function redactKey(key: string): string {
  const parts = key.split('_');
  if (parts.length < 2) return '****';
  // pf_live_<handle>_<secret> → keep everything except the last segment
  return `${parts.slice(0, Math.max(2, parts.length - 1)).join('_')}_****`;
}
