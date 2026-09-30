/**
 * FootballDataClient — the supported way for external applications (prediction
 * apps, dashboards, bots) to read the Football Data Platform.
 *
 * ```ts
 * const api = new FootballDataClient({
 *   baseUrl: process.env.FOOTBALL_API_BASE_URL!,   // https://api.yourdomain.com/api/v1
 *   apiKey:  process.env.FOOTBALL_API_KEY!,        // pf_live_…
 * });
 * const { data: fixtures } = await api.fixturesUpcoming({ per_page: 50 });
 * const { data: features } = await api.predictionFeatures(fixtures[0].id);
 * ```
 *
 * Design notes
 * - Zero runtime dependencies (uses the global `fetch`; Node >= 18 or any browser).
 * - Sends the key in the `X-API-Key` header only — never in the URL, never in a
 *   query string, never in a `Cookie`.
 * - Retries 429 (honouring `Retry-After`), 5xx and network errors with
 *   exponential backoff + jitter; never retries 401/403/404 (they are terminal).
 * - Converts PostgreSQL numeric strings to numbers so model code can do maths.
 */
import {
  FootballApiError,
  NetworkError,
  errorFromResponse,
} from './errors.js';
import {
  backoffMs,
  coerceNumbers,
  looksLikePlatformKey,
  redactKey,
  sleep,
  toQuery,
} from './util.js';
import type {
  Competition,
  CompetitionSeason,
  Envelope,
  Fixture,
  FixtureEvent,
  FixtureQuery,
  HealthStatus,
  ServiceHealth,
  ProviderHealth,
  DataQualityHealth,
  LeagueSeasonStats,
  Lineup,
  PageQuery,
  Paginated,
  Pagination,
  Player,
  PlayerQuery,
  PredictionFeatures,
  Referee,
  Standings,
  Team,
  TeamQuery,
  TeamSeasonStats,
} from './types.js';

export interface RateLimitSnapshot {
  remainingMinute: number | null;
  remainingDay: number | null;
}

export interface FootballDataClientOptions {
  /** Base URL of the platform API, e.g. `https://api.yourdomain.com/api/v1`. */
  baseUrl: string;
  /** Platform-issued key (`pf_live_…`). Never the API-Football provider key. */
  apiKey: string;
  /** Per-request timeout in ms (default 15 000). */
  timeoutMs?: number;
  /** Retries for 429/5xx/network errors (default 3). */
  maxRetries?: number;
  /** Base backoff in ms (default 400; exponential with jitter, capped at 15 s). */
  retryBaseMs?: number;
  /** Default page size for paginated endpoints (default 50, max 100). */
  perPage?: number;
  /** Convert numeric strings to numbers (default true). */
  coerceNumbers?: boolean;
  /** Field keys that must stay strings when coercing (e.g. `code`, `display_name`). */
  stringFields?: string[];
  /** Inject a custom fetch (tests, proxies, instrumentation). */
  fetch?: typeof globalThis.fetch;
  /** Called with one line per retry — useful for alerting on quota pressure. */
  onRetry?: (info: { attempt: number; waitMs: number; error: FootballApiError }) => void;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

const RETRY_CAP_MS = 15_000;

export class FootballDataClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly perPage: number;
  private readonly coerce: boolean;
  private readonly stringFields: Set<string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onRetry?: FootballDataClientOptions['onRetry'];
  private readonly extraHeaders: Record<string, string>;

  /** Rate-limit state from the most recent response. */
  rateLimit: RateLimitSnapshot = { remainingMinute: null, remainingDay: null };

  constructor(options: FootballDataClientOptions) {
    if (!options?.baseUrl) throw new Error('FootballDataClient: baseUrl is required');
    if (!options?.apiKey) throw new Error('FootballDataClient: apiKey is required');

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 400;
    this.perPage = Math.min(100, Math.max(1, options.perPage ?? 50));
    this.coerce = options.coerceNumbers ?? true;
    this.stringFields = new Set(options.stringFields ?? ['code', 'short_code', 'display_name', 'time_label']);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onRetry = options.onRetry;
    this.extraHeaders = options.headers ?? {};

    if (!looksLikePlatformKey(this.apiKey)) {
      // Not fatal — the server is the authority — but catch copy/paste mistakes
      // early (e.g. pasting the provider key or a truncated secret).
      // eslint-disable-next-line no-console
      console.warn(
        `[football-client] the API key does not look like a platform key (${redactKey(this.apiKey)}). ` +
          'Expected format: pf_live_<12 hex>_<secret>. Make sure you are not using the API-Football provider key.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // core request plumbing
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    params: object = {},
    init: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${toQuery(params)}`;
    let lastError: FootballApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const waitMs = lastError?.retryAfterSeconds
          ? Math.min(RETRY_CAP_MS, lastError.retryAfterSeconds * 1000 + 250)
          : backoffMs(attempt - 1, this.retryBaseMs, RETRY_CAP_MS);
        if (lastError) this.onRetry?.({ attempt, waitMs, error: lastError });
        try {
          await sleep(waitMs, init.signal);
        } catch {
          throw lastError ?? new NetworkError('aborted');
        }
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'X-API-Key': this.apiKey,
            Accept: 'application/json',
            'User-Agent': 'football-data-platform-client/1.0',
            ...this.extraHeaders,
          },
          signal: AbortSignal.any
            ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(init.signal ? [init.signal] : [])])
            : init.signal,
        });
      } catch (err) {
        lastError = new NetworkError(`network error calling ${path}: ${(err as Error).message}`, { cause: err });
        continue;
      }

      const remainingMinute = res.headers.get('x-ratelimit-remaining-minute');
      const remainingDay = res.headers.get('x-ratelimit-remaining-day');
      if (remainingMinute !== null || remainingDay !== null) {
        this.rateLimit = {
          remainingMinute: remainingMinute === null ? null : Number(remainingMinute),
          remainingDay: remainingDay === null ? null : Number(remainingDay),
        };
      }

      if (res.ok) {
        const json = (await res.json()) as unknown;
        return (this.coerce ? coerceNumbers(json, this.stringFields) : json) as T;
      }

      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body (e.g. proxy HTML) */
      }
      lastError = errorFromResponse(res.status, body, {
        retryAfter: res.headers.get('retry-after'),
        remainingMinute,
        remainingDay,
      });

      if (!lastError.retryable) throw lastError;
    }

    throw lastError ?? new FootballApiError(`request to ${path} failed`);
  }

  private async get<T>(path: string, params: object = {}): Promise<Envelope<T>> {
    return this.request<Envelope<T>>(path, params);
  }

  private async list<T>(
    path: string,
    params: object = {},
  ): Promise<Paginated<T>> {
    return this.request<Paginated<T>>(path, { per_page: this.perPage, ...params });
  }

  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------

  /** NOTE: health endpoints are not wrapped in the `data` envelope. */
  health(): Promise<HealthStatus> {
    return this.request<HealthStatus>('/health');
  }

  healthDatabase(): Promise<ServiceHealth> {
    return this.request<ServiceHealth>('/health/database');
  }

  healthRedis(): Promise<ServiceHealth> {
    return this.request<ServiceHealth>('/health/redis');
  }

  healthProvider(): Promise<ProviderHealth> {
    return this.request<ProviderHealth>('/health/provider');
  }

  /** Data-quality status; useful as a pre-flight check before batch scoring. */
  healthData(): Promise<DataQualityHealth> {
    return this.request<DataQualityHealth>('/health/data');
  }

  // -------------------------------------------------------------------------
  // competitions / teams / players / referees
  // -------------------------------------------------------------------------

  competitions(params: PageQuery & { country?: string } = {}): Promise<Paginated<Competition>> {
    return this.list<Competition>('/competitions', params);
  }

  competition(id: number): Promise<Envelope<Competition>> {
    return this.get<Competition>(`/competitions/${id}`);
  }

  competitionSeasons(id: number): Promise<Envelope<CompetitionSeason[]>> {
    return this.get<CompetitionSeason[]>(`/competitions/${id}/seasons`);
  }

  competitionStatistics(id: number, seasonId: number): Promise<Envelope<LeagueSeasonStats>> {
    return this.get<LeagueSeasonStats>(`/competitions/${id}/statistics`, { season_id: seasonId });
  }

  teams(params: TeamQuery = {}): Promise<Paginated<Team>> {
    return this.list<Team>('/teams', params);
  }

  team(id: number): Promise<Envelope<Team>> {
    return this.get<Team>(`/teams/${id}`);
  }

  teamStatistics(id: number, competitionId: number, seasonId: number): Promise<Envelope<TeamSeasonStats>> {
    return this.get<TeamSeasonStats>(`/teams/${id}/statistics`, {
      competition_id: competitionId,
      season_id: seasonId,
    });
  }

  players(params: PlayerQuery = {}): Promise<Paginated<Player>> {
    return this.list<Player>('/players', params);
  }

  player(id: number): Promise<Envelope<Player>> {
    return this.get<Player>(`/players/${id}`);
  }

  playerStatistics(id: number, params: { competition_id?: number; season_id?: number } = {}): Promise<Envelope<unknown>> {
    return this.get(`/players/${id}/statistics`, params);
  }

  referees(params: PageQuery = {}): Promise<Paginated<Referee>> {
    return this.list<Referee>('/referees', params);
  }

  referee(id: number): Promise<Envelope<Referee>> {
    return this.get<Referee>(`/referees/${id}`);
  }

  refereeStatistics(
    id: number,
    params: { competition_id?: number; season_id?: number } = {},
  ): Promise<Envelope<unknown>> {
    return this.get(`/referees/${id}/statistics`, params);
  }

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  fixtures(params: FixtureQuery = {}): Promise<Paginated<Fixture>> {
    return this.list<Fixture>('/fixtures', params);
  }

  fixturesUpcoming(params: PageQuery = {}): Promise<Paginated<Fixture>> {
    return this.list<Fixture>('/fixtures/upcoming', params);
  }

  fixturesLive(): Promise<Envelope<Fixture[]>> {
    return this.get<Fixture[]>('/fixtures/live');
  }

  fixturesFinished(params: PageQuery & { date?: string } = {}): Promise<Paginated<Fixture>> {
    return this.list<Fixture>('/fixtures/finished', params);
  }

  fixture(id: number): Promise<Envelope<Fixture>> {
    return this.get<Fixture>(`/fixtures/${id}`);
  }

  fixtureEvents(id: number): Promise<Envelope<FixtureEvent[]>> {
    return this.get<FixtureEvent[]>(`/fixtures/${id}/events`);
  }

  fixtureStatistics(id: number): Promise<Envelope<unknown>> {
    return this.get(`/fixtures/${id}/statistics`);
  }

  fixtureLineups(id: number): Promise<Envelope<Lineup[]>> {
    return this.get<Lineup[]>(`/fixtures/${id}/lineups`);
  }

  fixturePlayers(id: number): Promise<Envelope<unknown[]>> {
    return this.get<unknown[]>(`/fixtures/${id}/players`);
  }

  standings(competitionId: number, seasonId: number): Promise<Envelope<Standings>> {
    return this.get<Standings>('/standings', { competition_id: competitionId, season_id: seasonId });
  }

  // -------------------------------------------------------------------------
  // predictions
  // -------------------------------------------------------------------------

  /**
   * Model-ready features for one fixture. Computed by the platform — no
   * provider call happens on this path, so it is cheap and fast.
   */
  predictionFeatures(fixtureId: number): Promise<Envelope<PredictionFeatures>> {
    return this.get<PredictionFeatures>(`/predictions/features/${fixtureId}`);
  }

  /**
   * Fetch features for many fixtures sequentially (the API is per-fixture).
   * `onFeatures` is called as soon as each result arrives; failures are
   * collected instead of aborting the batch (a single missing feature row
   * should not kill a scoring run).
   */
  async predictionFeaturesBatch(
    fixtureIds: readonly number[],
    options: { concurrency?: number; onFeatures?: (features: PredictionFeatures, fixtureId: number) => void } = {},
  ): Promise<{ features: PredictionFeatures[]; failures: Array<{ fixtureId: number; error: FootballApiError }> }> {
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const features: PredictionFeatures[] = [];
    const failures: Array<{ fixtureId: number; error: FootballApiError }> = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= fixtureIds.length) return;
        const id = fixtureIds[index];
        try {
          const { data } = await this.predictionFeatures(id);
          features.push(data);
          options.onFeatures?.(data, id);
        } catch (err) {
          failures.push({ fixtureId: id, error: err as FootballApiError });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, fixtureIds.length) }, worker));
    return { features, failures };
  }

  // -------------------------------------------------------------------------
  // pagination helpers
  // -------------------------------------------------------------------------

  /** Iterate page by page (`for await (const page of api.pages('/fixtures', {...}))`). */
  async *pages<T>(path: string, params: object = {}): AsyncGenerator<Paginated<T>> {
    let page = 1;
    for (;;) {
      const result = await this.request<Paginated<T>>(path, { per_page: this.perPage, ...params, page });
      yield result;
      const pagination: Pagination | undefined = result.pagination;
      if (!pagination || page >= pagination.total_pages) return;
      page = pagination.page + 1;
    }
  }

  /** Iterate item by item, following pagination transparently. */
  async *iterate<T>(path: string, params: object = {}): AsyncGenerator<T> {
    for await (const page of this.pages<T>(path, params)) {
      for (const item of page.data) yield item;
    }
  }

  /** Collect every page into one array (use with care on large endpoints). */
  async all<T>(path: string, params: object = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.iterate<T>(path, params)) out.push(item);
    return out;
  }
}

export type FootballApiClient = FootballDataClient;
export { FootballApiClient as Client };
