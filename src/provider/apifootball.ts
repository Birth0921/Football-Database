import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { paramStringHash, safeParams } from '../lib/hash.js';
import { quotaManager, taskClassFor, type TaskClass } from '../sync/quota.js';
import { getTaskContext } from '../sync/task-context.js';
import { AppError, ProviderRequestResult, ProviderResponse } from '../types.js';
import type { FootballProvider } from './client.js';
import { storeRawPayload } from './rawstore.js';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * API-Football returns /fixtures rows with fixture-specific fields nested
 * under `fixture`. The application mapper intentionally uses a flattened
 * AfFixture shape, so normalize at the provider boundary.
 *
 * The original response object is never mutated; raw storage continues to
 * receive the exact provider payload.
 */
function normalizeFixtureResponse<T>(body: ProviderResponse<T>): ProviderResponse<T> {
  if (!Array.isArray(body.response)) return body;

  const response = body.response.map((item) => {
    const row = item as T & { fixture?: Record<string, unknown> };
    if (!row || typeof row !== 'object' || !row.fixture) return item;

    return {
      ...row.fixture,
      ...row,
    } as T;
  });

  return { ...body, response };
}

/**
 * Live API-Football client.
 * - quota-aware (daily + per-minute)
 * - retries 429/5xx with exponential backoff
 * - logs provider_requests (never with the secret)
 * - stores raw payloads
 */
export class ApiFootballClient implements FootballProvider {
  name = 'api-football';
  mode = 'live' as const;

  constructor(
    private apiKey: string = config.apiFootballKey,
    private baseUrl: string = config.apiFootballBaseUrl,
  ) {
    if (!this.apiKey) throw new Error('API_FOOTBALL_KEY is required for live provider mode');
  }

  async verifyCredentials(): Promise<{ ok: boolean; detail: string; quota?: unknown }> {
    try {
      const res = await this.get('/status', {});
      const errors = res.data.errors;
      const hasErrors = Array.isArray(errors) ? errors.length > 0 : Object.keys(errors ?? {}).length > 0;
      if (res.httpStatus === 200 && !hasErrors) {
        return { ok: true, detail: 'API-Football credentials verified', quota: res.data.response[0] ?? null };
      }
      return { ok: false, detail: `API-Football rejected credentials: ${JSON.stringify(errors)}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async get<T = unknown>(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<ProviderRequestResult<T>> {
    await quotaManager.rollMinuteWindow();
    // /status is a quota-free management endpoint: always allowed so quota
    // reconciliation works even when the local state is CRITICAL/EXHAUSTED.
    if (endpoint !== '/status') {
      const st = await quotaManager.status();
      if (st.state === 'EXHAUSTED' || st.dailyRemaining <= 0) {
        throw new AppError('Provider daily quota exhausted for today', 503, 'PROVIDER_QUOTA_EXHAUSTED');
      }
      // Class-aware policy: essential (live/upcoming fixture) sync keeps
      // running while quota is low; background traffic waits for NORMAL.
      const explicit = (params as { quotaClass?: string }).quotaClass;
      const taskContext = getTaskContext();
      const cls: TaskClass =
        explicit === 'essential' || explicit === 'background'
          ? explicit
          : taskClassFor(taskContext?.taskType);
      if (cls === 'background' && st.state !== 'NORMAL') {
        throw new AppError(
          `Provider quota ${st.state.toLowerCase()} — background traffic deferred (${st.dailyRemaining} of ${st.dailyLimit} requests remaining)`,
          503,
          'PROVIDER_QUOTA_DEFERRED',
        );
      }
      await quotaManager.waitForCapacity();
    }

    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' || k === 'priority' || k === 'quotaClass') continue;
      search.set(k, String(v));
    }
    const qs = search.toString();
    const url = `${this.baseUrl}${endpoint}${qs ? `?${qs}` : ''}`;
    const paramHash = paramStringHash(params);
    const startedAt = new Date();
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < 4) {
      attempt += 1;
      const t0 = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'x-apisports-key': this.apiKey,
            accept: 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const httpStatus = res.status;
        let body: ProviderResponse<T>;
        try {
          body = (await res.json()) as ProviderResponse<T>;
        } catch {
          body = { get: endpoint, parameters: safeParams(params), errors: ['malformed JSON'], results: 0, paging: { current: 1, total: 1 }, response: [] };
        }

        const dailyRemaining = extractIntHeader(res.headers, 'x-ratelimit-requests-remaining');
        const minuteRemaining = extractIntHeader(res.headers, 'x-ratelimit-requests-remaining-minute');

        if (RETRY_STATUS.has(httpStatus)) {
          lastError = new Error(`HTTP ${httpStatus}`);
          await this.logRequest(endpoint, paramHash, startedAt, t0, httpStatus, false, dailyRemaining, minuteRemaining, `retryable ${httpStatus}`);
          const backoff = Math.min(1000 * 2 ** (attempt - 1), 15_000) + Math.floor(Math.random() * 500);
          if (httpStatus === 429) {
            const retryAfter = Number(res.headers.get('retry-after') ?? 0);
            await sleep(Math.max(backoff, retryAfter * 1000));
          } else {
            await sleep(backoff);
          }
          continue;
        }

        const ok = httpStatus === 200;
        const normalizedBody = endpoint === '/fixtures'
          ? normalizeFixtureResponse(body)
          : body;
        if (ok) {
          if (endpoint === '/status') {
            // management endpoint: does not consume quota; its counters are
            // AUTHORITATIVE and reconcile the local state.
            const item = (body.response as Array<{ requests?: { current?: number; limit_day?: number } }> | undefined)?.[0];
            const current = item?.requests?.current;
            if (typeof current === 'number') {
              const limitDay = typeof item?.requests?.limit_day === 'number' ? item!.requests!.limit_day : null;
              await quotaManager.observeExternal(current, limitDay ?? config.providerDailyQuota);
            }
          } else {
            await quotaManager.recordUse(dailyRemaining, minuteRemaining);
          }
          await storeRawPayload({
            endpoint,
            params,
            entityType: endpoint.replace(/\W+/g, '_'),
            responseJson: body,
            httpStatus,
          });
        }
        await this.logRequest(endpoint, paramHash, startedAt, t0, httpStatus, ok, dailyRemaining, minuteRemaining, ok ? null : JSON.stringify(body.errors));

        const hasErrors = Array.isArray(body.errors) ? body.errors.length > 0 : Object.keys(body.errors ?? {}).length > 0;
        if (!ok || (hasErrors && body.results === 0)) {
          if (httpStatus === 401 || httpStatus === 403) {
            throw new AppError('Provider authentication failed — check API_FOOTBALL_KEY', 502, 'PROVIDER_AUTH');
          }
          if (httpStatus === 404) {
            return {
          data: endpoint === '/fixtures' ? normalizedBody : body,
          httpStatus,
          fromCache: false,
          dailyRemaining,
          minuteRemaining,
        };
          }
        }
        return {
          data: endpoint === '/fixtures' ? normalizedBody : body,
          httpStatus,
          fromCache: false,
          dailyRemaining,
          minuteRemaining,
        };
      } catch (err) {
        lastError = err;
        if (err instanceof AppError) throw err;
        // network error / timeout → backoff and retry
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
      }
    }
    await this.logRequest(endpoint, paramHash, startedAt, Date.now(), 0, false, null, null, String(lastError));
    throw new AppError(`Provider request failed after retries: ${String(lastError)}`, 502, 'PROVIDER_ERROR');
  }

  private async logRequest(
    endpoint: string,
    paramHash: string,
    startedAt: Date,
    t0: number,
    httpStatus: number,
    success: boolean,
    dailyRemaining: number | null,
    minuteRemaining: number | null,
    error: string | null,
  ): Promise<void> {
    await query(
      `INSERT INTO provider_requests
        (endpoint, http_method, request_param_hash, started_at, completed_at, duration_ms, http_status,
         success, cache_hit, daily_quota_remaining, minute_quota_remaining, sync_task, error_message)
       VALUES ($1, 'GET', $2, $3, now(), $4, $5, $6, false, $7, $8, $9, $10)`,
      [
        endpoint,
        paramHash,
        startedAt,
        Date.now() - t0,
        httpStatus || null,
        success,
        dailyRemaining,
        minuteRemaining,
        getTaskContext()?.taskKey ?? null,
        error ? error.slice(0, 500) : null,
      ],
    );
    logger.info({ endpoint, httpStatus, success, dailyRemaining }, 'provider request');
  }
}

function extractIntHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
