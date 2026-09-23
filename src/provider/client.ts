import { config, redactSecrets } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db/pool.js';
import { cacheGetJson, cacheSetJson } from '../redis/client.js';
import { paramsHash, sleep } from '../util/hash.js';
import { quotaManager } from './quota.js';

const log = logger.child({ mod: 'provider' });

export interface ProviderParams {
  [key: string]: string | number | undefined;
}

export interface ProviderEnvelope {
  get: string;
  parameters: Record<string, string>;
  errors: string[] | Record<string, string> | null;
  results: number;
  paging: { current: number; total: number };
  response: unknown[];
}

export interface ProviderCallResult {
  envelope: ProviderEnvelope;
  httpStatus: number;
  cacheHit: boolean;
  durationMs: number;
  fromRedis: boolean;
}

const RATE_LOCK_KEY = 'provider:rate-slot';

const NON_RETRYABLE = new Set([401, 403, 404]);

export class ProviderError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly endpoint?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

function endpointSupportCacheKey(endpoint: string, params: ProviderParams): string {
  return `pcache:${paramsHash(endpoint, params)}`;
}

/**
 * API-Football HTTP client.
 * - never exposes the provider key (header only, never logged, never stored)
 * - Redis response cache with short TTL to absorb duplicate polls
 * - raw payload + request logging into PostgreSQL for reprocessing
 * - quota-aware, rate limited, retries with exponential backoff on 5xx/429/timeouts
 */
export class ApiFootballClient {
  private activeRequests = 0;
  private lastRequestAt = 0;

  get hasKey(): boolean {
    return Boolean(config.provider.key);
  }

  private headers(): Record<string, string> {
    const base = config.provider.baseUrl;
    if (base.includes('rapidapi')) {
      return {
        'x-rapidapi-key': config.provider.key,
        'x-rapidapi-host': base.replace(/^https?:\/\//, '').split('/')[0],
      };
    }
    return { 'x-apisports-key': config.provider.key };
  }

  private buildUrl(endpoint: string, params: ProviderParams): string {
    const url = new URL(`${config.provider.baseUrl}/${endpoint.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v).length > 0) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async checkStatus(): Promise<{ ok: boolean; message: string; account?: unknown }> {
    if (!this.hasKey) return { ok: false, message: 'API_FOOTBALL_KEY is not configured' };
    try {
      const url = this.buildUrl('status', {});
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as ProviderEnvelope & { response?: unknown };
      if (res.ok && body && Array.isArray(body.response) && body.response.length > 0) {
        const account = body.response[0] as {
          account?: { firstname?: string };
          subscription?: { plan?: string; end?: string; active?: boolean };
          requests?: { current?: number; limit_day?: number };
        };
        if (account.requests?.limit_day) {
          await quotaManager.updateFromProvider({
            dailyLimit: account.requests.limit_day,
            dailyUsed: account.requests.current ?? 0,
            source: 'status',
          });
        }
        return {
          ok: true,
          message: `provider OK: plan=${account.subscription?.plan ?? 'unknown'} requestsToday=${account.requests?.current ?? '?'} limitDay=${account.requests?.limit_day ?? '?'}`,
          account,
        };
      }
      return { ok: false, message: `provider responded ${res.status} without account data` };
    } catch (err) {
      return { ok: false, message: redactSecrets(err instanceof Error ? err.message : String(err)) };
    }
  }

  /**
   * Perform a provider GET. Applies: Redis cache -> rate limit -> retry w/ backoff ->
   * raw payload persistence -> provider_requests logging.
   */
  async get(
    endpoint: string,
    params: ProviderParams = {},
    opts: { priority?: 'live' | 'high' | 'medium' | 'low'; cacheTtlSeconds?: number; syncTaskId?: number | null; rawEntityType?: string } = {},
  ): Promise<ProviderCallResult> {
    if (!this.hasKey) throw new ProviderError('API_FOOTBALL_KEY is not configured', 401, endpoint);
    const started = new Date();
    const pHash = paramsHash(endpoint, params as Record<string, unknown>);
    const cacheKey = endpointSupportCacheKey(endpoint, params);
    const cacheTtl = opts.cacheTtlSeconds ?? 60;

    // 1. Redis short-TTL cache
    const cached = await cacheGetJson<{ status: number; envelope: ProviderEnvelope }>(cacheKey);
    if (cached) {
      void this.logRequest(endpoint, params, pHash, started, cached.status, true, 0, opts.syncTaskId ?? null);
      return { envelope: cached.envelope, httpStatus: cached.status, cacheHit: true, durationMs: 0, fromRedis: true };
    }

    // 2. quota gates
    const priority = opts.priority ?? 'medium';
    if (!(await quotaManager.allowsPriority(priority))) {
      throw new ProviderError(`provider request skipped: quota ${priority} gate closed for ${endpoint}`, 429, endpoint);
    }

    const url = this.buildUrl(endpoint, params);
    let attempt = 0;
    let lastErr: Error | null = null;

    while (attempt < 5) {
      attempt++;
      await this.throttle();
      const reqStart = new Date();
      try {
        this.activeRequests++;
        const res = await fetch(url, {
          headers: this.headers(),
          signal: AbortSignal.timeout(30_000),
        });
        this.lastRequestAt = Date.now();
        const durationMs = Date.now() - reqStart.getTime();
        this.activeRequests--;

        // record quota headers when present
        this.captureQuotaHeaders(res.headers);

        const text = await res.text();
        let envelope: ProviderEnvelope;
        try {
          envelope = JSON.parse(text) as ProviderEnvelope;
        } catch {
          envelope = { get: endpoint, parameters: {}, errors: ['malformed JSON response'], results: 0, paging: { current: 1, total: 1 }, response: [] };
        }

        await this.persistRaw(endpoint, params, pHash, envelope, res.status, opts.rawEntityType);
        await this.logRequest(endpoint, params, pHash, reqStart, res.status, false, durationMs, opts.syncTaskId ?? null);

        if (res.status === 429) {
          lastErr = new ProviderError('rate limited by provider (429)', 429, endpoint);
          const retryAfter = res.headers.get('retry-after');
          const wait = retryAfter ? Math.min(120, parseInt(retryAfter, 10) || 10) : Math.min(60, 2 ** attempt * 2);
          log.warn({ endpoint, attempt, wait }, '429 — backing off');
          await sleep(wait * 1000);
          continue;
        }
        if (res.status >= 500 || res.status === 502 || res.status === 503 || res.status === 504) {
          lastErr = new ProviderError(`provider server error ${res.status}`, res.status, endpoint);
          await sleep(Math.min(60_000, 2 ** attempt * 500));
          continue;
        }
        if (NON_RETRYABLE.has(res.status)) {
          throw new ProviderError(`provider ${res.status} for ${endpoint}`, res.status, endpoint);
        }
        if (!res.ok) {
          throw new ProviderError(`provider unexpected status ${res.status} for ${endpoint}`, res.status, endpoint);
        }

        // provider-level errors array (HTTP 200 but errors present)
        const providerErrors = envelope.errors;
        const hasProviderError =
          (Array.isArray(providerErrors) && providerErrors.length > 0) ||
          (providerErrors && typeof providerErrors === 'object' && Object.keys(providerErrors).length > 0);
        if (hasProviderError) {
          const msg = JSON.stringify(providerErrors);
          if (/token|key|subscription|plan/i.test(msg)) {
            throw new ProviderError(`provider rejected request: ${msg}`, 403, endpoint);
          }
          // endpoint not available for these params — treat as empty
          log.warn({ endpoint, params, msg }, 'provider reported soft error');
        }

        if (cacheTtl > 0 && Array.isArray(envelope.response)) {
          await cacheSetJson(cacheKey, { status: res.status, envelope }, cacheTtl);
        }
        return { envelope, httpStatus: res.status, cacheHit: false, durationMs, fromRedis: false };
      } catch (err) {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        if (err instanceof ProviderError) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt >= 5) break;
        await sleep(Math.min(30_000, 2 ** attempt * 500));
      } finally {
        this.activeRequests = Math.max(0, this.activeRequests);
      }
    }

    await this.logRequest(endpoint, params, pHash, started, null, false, Date.now() - started.getTime(), opts.syncTaskId ?? null, lastErr?.message);
    throw new ProviderError(`provider call failed after ${attempt} attempts: ${redactSecrets(lastErr?.message ?? 'unknown')}`, undefined, endpoint);
  }

  /** Fetch all pages (players endpoint paginates). */
  async getAllPages(
    endpoint: string,
    params: ProviderParams = {},
    opts: { priority?: 'live' | 'high' | 'medium' | 'low'; maxPages?: number; syncTaskId?: number | null; rawEntityType?: string } = {},
  ): Promise<ProviderEnvelope[]> {
    const first = await this.get(endpoint, params, { ...opts, rawEntityType: opts.rawEntityType });
    const pages: ProviderEnvelope[] = [first.envelope];
    const total = first.envelope.paging?.total ?? 1;
    const max = Math.min(opts.maxPages ?? total, total, 60);
    for (let p = 2; p <= max; p++) {
      const next = await this.get(endpoint, { ...params, page: p }, { ...opts, rawEntityType: opts.rawEntityType });
      pages.push(next.envelope);
    }
    return pages;
  }

  private captureQuotaHeaders(headers: Headers): void {
    const dailyLimit = headers.get('x-ratelimit-requests-limit');
    const dailyRemaining = headers.get('x-ratelimit-requests-remaining');
    const minuteLimit = headers.get('x-ratelimit-limit');
    const minuteRemaining = headers.get('x-ratelimit-remaining');
    if (dailyLimit || minuteLimit) {
      void quotaManager.updateFromProvider({
        dailyLimit: dailyLimit ? parseInt(dailyLimit, 10) : undefined,
        dailyUsed: dailyLimit && dailyRemaining ? parseInt(dailyLimit, 10) - parseInt(dailyRemaining, 10) : undefined,
        minuteLimit: minuteLimit ? parseInt(minuteLimit, 10) : undefined,
        minuteUsed: minuteLimit && minuteRemaining ? parseInt(minuteLimit, 10) - parseInt(minuteRemaining, 10) : undefined,
        source: 'headers',
      });
    }
  }

  /** Simple concurrency + minimum-interval throttle. */
  private async throttle(): Promise<void> {
    const minInterval = Math.ceil(1000 / Math.max(0.5, config.provider.maxRps));
    while (this.activeRequests >= 8) {
      await sleep(50);
    }
    const since = Date.now() - this.lastRequestAt;
    if (since < minInterval) await sleep(minInterval - since);
  }

  private async persistRaw(
    endpoint: string,
    params: ProviderParams,
    pHash: string,
    envelope: ProviderEnvelope,
    httpStatus: number,
    entityType?: string,
  ): Promise<void> {
    try {
      // extract primary provider entity id for indexed lookup
      let providerEntityId: number | null = null;
      if (params.league) providerEntityId = Number(params.league);
      else if (params.team) providerEntityId = Number(params.team);
      else if (params.player) providerEntityId = Number(params.player);
      else if (params.id) providerEntityId = Number(params.id);

      const { rows } = await query<{ id: number }>(
        `SELECT cs.id FROM competition_seasons cs WHERE cs.provider = 'api-football' AND cs.provider_id = $1
         AND cs.season_id = (SELECT id FROM seasons WHERE year = $2::int) LIMIT 1`,
        [params.league ? Number(params.league) : -1, params.season ? Number(params.season) : -1],
      ).catch(() => ({ rows: [] as { id: number }[] }));

      await query(
        `INSERT INTO raw_provider_payloads
           (provider, endpoint, params, params_hash, entity_type, provider_entity_id,
            fixture_id, competition_season_id, response, http_status, response_hash)
         VALUES ('api-football', $1, $2::jsonb, $3, $4, $5,
           (SELECT id FROM fixtures WHERE provider='api-football' AND provider_id=$6::bigint LIMIT 1),
           $7::bigint, $8::jsonb, $9, $10)
         ON CONFLICT (provider, params_hash) DO NOTHING`,
        [
          endpoint,
          JSON.stringify(params),
          pHash,
          entityType ?? endpoint,
          providerEntityId,
          params.id ? Number(params.id) : null,
          rows[0]?.id ?? null,
          JSON.stringify(envelope),
          httpStatus,
          `${endpoint}:${pHash}`,
        ].map((v) => (v === undefined ? null : v)),
      );
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err, endpoint }, 'raw payload persistence failed (non-fatal)');
    }
  }

  private async logRequest(
    endpoint: string,
    params: ProviderParams,
    pHash: string,
    startedAt: Date,
    httpStatus: number | null,
    cacheHit: boolean,
    durationMs: number,
    syncTaskId: number | null,
    error?: string,
  ): Promise<void> {
    try {
      const snap = await quotaManager.snapshot();
      await query(
        `INSERT INTO provider_requests
           (endpoint, params, params_hash, started_at, completed_at, duration_ms, http_status,
            success, cache_hit, daily_quota_remaining, minute_quota_remaining, sync_task_id, error)
         VALUES ('api-football', $1::jsonb, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          JSON.stringify(params),
          pHash,
          startedAt,
          Math.round(durationMs),
          httpStatus,
          httpStatus !== null && httpStatus < 400,
          cacheHit,
          snap.dailyRemaining,
          snap.minuteRemaining,
          syncTaskId,
          error ? redactSecrets(error) : null,
        ],
      );
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, 'provider request logging failed (non-fatal)');
    }
  }
}

export const providerClient = new ApiFootballClient();
