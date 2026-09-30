/**
 * Error types thrown by {@link FootballApiClient}.
 *
 * Every error extends `FootballApiError`, so a single `catch` is enough if you
 * do not care about the distinction. The status code and the platform error
 * code (`NOT_FOUND`, `RATE_LIMITED`, …) are always preserved.
 */

export interface FootballApiErrorOptions {
  status?: number;
  code?: string;
  /** Seconds to wait before retrying (only set for 429 / Retry-After). */
  retryAfterSeconds?: number;
  /** Remaining quota reported by the API, when known. */
  remainingMinute?: number | null;
  remainingDay?: number | null;
  cause?: unknown;
}

export class FootballApiError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;
  readonly remainingMinute: number | null;
  readonly remainingDay: number | null;

  constructor(message: string, options: FootballApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code ?? 'UNKNOWN';
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.remainingMinute = options.remainingMinute ?? null;
    this.remainingDay = options.remainingDay ?? null;
  }

  /** True for transport problems and 5xx — safe to retry. */
  get retryable(): boolean {
    return this instanceof RateLimitError || this instanceof ServerError || this instanceof NetworkError;
  }
}

/** 400 — malformed/invalid query parameters. */
export class ValidationError extends FootballApiError {}

/** 401 — missing, unknown, revoked or expired API key. Not retryable. */
export class AuthenticationError extends FootballApiError {}

/** 403 — key is valid but lacks the required scope, or the client is disabled. */
export class PermissionError extends FootballApiError {}

/** 404 — resource does not exist (e.g. prediction features not built yet). */
export class NotFoundError extends FootballApiError {}

/** 429 — per-minute or per-day quota exhausted. Honour `retryAfterSeconds`. */
export class RateLimitError extends FootballApiError {
  constructor(message: string, options: FootballApiErrorOptions = {}) {
    super(message, { code: 'RATE_LIMITED', ...options });
  }
}

/** 5xx — platform-side failure. Retried automatically by the client. */
export class ServerError extends FootballApiError {}

/** DNS/TLS/timeout/connection-reset — retried automatically by the client. */
export class NetworkError extends FootballApiError {
  constructor(message: string, options: FootballApiErrorOptions = {}) {
    super(message, { code: 'NETWORK', ...options });
  }
}

/**
 * Build the right error class from an HTTP response.
 * `body` is the parsed `{ ok:false, error:{ code, message } }` envelope, when present.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers: { retryAfter?: string | null; remainingMinute?: string | null; remainingDay?: string | null } = {},
): FootballApiError {
  const parsed = (body ?? {}) as { error?: { code?: string; message?: string }; message?: string };
  const message = parsed.error?.message ?? parsed.message ?? `request failed with status ${status}`;
  const code = parsed.error?.code ?? String(status);
  const retryAfterSeconds = headers.retryAfter ? Number(headers.retryAfter) : undefined;
  const opts: FootballApiErrorOptions = {
    status,
    code,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    remainingMinute: headers.remainingMinute ? Number(headers.remainingMinute) : null,
    remainingDay: headers.remainingDay ? Number(headers.remainingDay) : null,
  };

  if (status === 400) return new ValidationError(message, opts);
  if (status === 401) return new AuthenticationError(message, { ...opts, code: code === String(status) ? 'UNAUTHORIZED' : code });
  if (status === 403) return new PermissionError(message, { ...opts, code: code === String(status) ? 'FORBIDDEN' : code });
  if (status === 404) return new NotFoundError(message, { ...opts, code: code === String(status) ? 'NOT_FOUND' : code });
  if (status === 429) return new RateLimitError(message, opts);
  if (status >= 500) return new ServerError(message, opts);
  return new FootballApiError(message, opts);
}
