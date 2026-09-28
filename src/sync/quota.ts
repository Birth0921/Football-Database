/**
 * Provider quota policy.
 *
 * The provider's own counters (API-Football /status, response headers when
 * present) are AUTHORITATIVE for remaining quota; local counting fills the
 * gaps between reconciliations and is corrected whenever the provider reports.
 *
 * Policy (PROVIDER_DAILY_QUOTA stays the configured limit):
 * - NORMAL    — everything may run.
 * - CAUTION   — remaining is at/below the background floor
 *              (max(2 × essential reserve, N% of quota)). Background traffic
 *              (metadata, historical imports, coverage/teams, injuries/odds…)
 *              is deferred with backoff. ESSENTIAL live/upcoming fixture sync
 *              keeps running.
 * - CRITICAL  — remaining is at/below the essential reserve: only essential
 *              sync continues (it is what the reserve is for).
 * - EXHAUSTED — remaining is 0: all provider traffic stops.
 *
 * Example: 29,355 of 150,000 remaining (19.6%) with default thresholds
 * (reserve 10,000, floor 30,000) is CAUTION: live + upcoming sync continue,
 * background imports wait for the daily reset. Quota numbers are never
 * fabricated and provider rate limits are never bypassed.
 */
import { query, queryOne } from '../lib/db.js';
import { config } from '../config.js';

export type QuotaState = 'NORMAL' | 'CAUTION' | 'CRITICAL' | 'EXHAUSTED';
export type TaskClass = 'essential' | 'background';

/** Task types that keep running while quota is low: live + upcoming fixture
 *  sync, post-match finalization and the current:sync cycle. Everything else
 *  (coverage, teams/squads, standings, injuries, transfers, odds, historical
 *  imports, metadata refreshes) is background. */
const ESSENTIAL_TASK_TYPES = new Set([
  'live:sync',
  'upcoming:sync',
  'current:sync',
  'postmatch:scan',
  'fixture:postmatch',
  'fixture:details',
]);

export function taskClassFor(taskType: string | null | undefined): TaskClass {
  return taskType && ESSENTIAL_TASK_TYPES.has(taskType) ? 'essential' : 'background';
}

export interface QuotaStatus {
  provider: string;
  day: string;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  minuteLimit: number;
  minuteUsed: number;
  minuteRemaining: number;
  state: QuotaState;
  essentialReserve: number;
  backgroundFloor: number;
  lastUpdatedAt: string | null;
  reconciledAt: string | null;
}

export interface QuotaGate {
  allowed: boolean;
  class: TaskClass;
  state: QuotaState;
  dailyRemaining: number;
  essentialReserve: number;
  backgroundFloor: number;
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class QuotaManager {
  constructor(private provider = 'api-football') {}

  /** Essential reserve + background floor derived from configuration. */
  thresholds(limit = config.providerDailyQuota): { essentialReserve: number; backgroundFloor: number } {
    const safeLimit = Math.max(limit, 1);
    const essentialReserve =
      config.providerEssentialReserve > 0
        ? Math.min(config.providerEssentialReserve, safeLimit - 1)
        : Math.max(50, Math.min(10_000, Math.round(safeLimit * 0.07)));
    const backgroundFloor = Math.min(
      Math.max(essentialReserve * 2, Math.round(safeLimit * (config.providerBackgroundFloorPercent / 100))),
      Math.max(safeLimit - 1, 0),
    );
    return { essentialReserve, backgroundFloor };
  }

  stateFor(remaining: number, limit = config.providerDailyQuota): QuotaState {
    const { essentialReserve, backgroundFloor } = this.thresholds(limit);
    if (remaining <= 0) return 'EXHAUSTED';
    if (remaining <= essentialReserve) return 'CRITICAL';
    if (remaining <= backgroundFloor) return 'CAUTION';
    return 'NORMAL';
  }

  async ensureToday(): Promise<void> {
    const { essentialReserve, backgroundFloor } = this.thresholds();
    void essentialReserve;
    void backgroundFloor;
    await query(
      `INSERT INTO provider_quota (provider, day, daily_limit, daily_used, daily_remaining, minute_limit, minute_used, minute_remaining)
       VALUES ($1, $2, $3, 0, $3, $4, 0, $4)
       ON CONFLICT (provider, day) DO NOTHING`,
      [this.provider, utcDay(), config.providerDailyQuota, config.providerMinuteLimit],
    );
  }

  /** Roll the minute window forward if it has elapsed. */
  async rollMinuteWindow(): Promise<void> {
    await this.ensureToday();
    await query(
      `UPDATE provider_quota
          SET minute_used = 0,
              minute_remaining = minute_limit,
              minute_window_start = now()
        WHERE provider = $1 AND day = $2
          AND minute_window_start < now() - interval '1 minute'`,
      [this.provider, utcDay()],
    );
  }

  async recordUse(dailyRemainingFromHeader?: number | null, minuteRemainingFromHeader?: number | null): Promise<void> {
    await this.rollMinuteWindow();
    const rows = await query<{ daily_remaining: number; minute_remaining: number; daily_limit: number; minute_limit: number }>(
      `WITH upd AS (
         UPDATE provider_quota
            SET daily_used = daily_used + 1,
                minute_used = minute_used + 1,
                daily_remaining = GREATEST(daily_remaining - 1, 0),
                minute_remaining = GREATEST(minute_remaining - 1, 0),
                last_updated_at = now()
          WHERE provider = $1 AND day = $2
          RETURNING daily_remaining, minute_remaining, daily_limit, minute_limit
       )
       SELECT daily_remaining, minute_remaining, daily_limit, minute_limit FROM upd`,
      [this.provider, utcDay()],
    );
    const row = rows[0];
    if (!row) return;
    let dailyRemaining = row.daily_remaining;
    let minuteRemaining = row.minute_remaining;
    // provider-reported header values (when present) are authoritative
    if (typeof dailyRemainingFromHeader === 'number') dailyRemaining = dailyRemainingFromHeader;
    if (typeof minuteRemainingFromHeader === 'number') minuteRemaining = minuteRemainingFromHeader;
    await query(
      `UPDATE provider_quota SET daily_remaining = $3, minute_remaining = $4, state = $5, last_updated_at = now()
        WHERE provider = $1 AND day = $2`,
      [this.provider, utcDay(), dailyRemaining, minuteRemaining, this.stateFor(dailyRemaining, row.daily_limit)],
    );
  }

  /**
   * Provider-reported counters (authoritative, e.g. from /status requests:
   * requests.current / requests.limit_day). Reconciles the local row even when
   * the local state is CRITICAL/EXHAUSTED — values are never fabricated, only
   * taken from the provider's own response.
   */
  async observeExternal(dailyUsed: number | null, dailyLimit: number | null): Promise<QuotaStatus> {
    await this.ensureToday();
    if (dailyUsed === null && dailyLimit === null) return this.status();
    const current = await queryOne<{ daily_limit: number }>(
      `SELECT daily_limit FROM provider_quota WHERE provider = $1 AND day = $2`,
      [this.provider, utcDay()],
    );
    const limit = dailyLimit ?? current?.daily_limit ?? config.providerDailyQuota;
    const used = Math.max(dailyUsed ?? 0, 0);
    const remaining = Math.max(limit - used, 0);
    await query(
      `UPDATE provider_quota
          SET daily_limit = $3, daily_used = $4, daily_remaining = $5, state = $6, reconciled_at = now(), last_updated_at = now()
        WHERE provider = $1 AND day = $2`,
      [this.provider, utcDay(), limit, used, remaining, this.stateFor(remaining, limit)],
    );
    return this.status();
  }

  async status(): Promise<QuotaStatus> {
    await this.rollMinuteWindow();
    const row = await queryOne<{
      provider: string;
      day: Date;
      daily_limit: number;
      daily_used: number;
      daily_remaining: number;
      minute_limit: number;
      minute_used: number;
      minute_remaining: number;
      state: QuotaState;
      last_updated_at: Date | null;
      reconciled_at: Date | null;
    }>(`SELECT * FROM provider_quota WHERE provider = $1 AND day = $2`, [this.provider, utcDay()]);
    if (!row) {
      await this.ensureToday();
      return this.status();
    }
    const state = this.stateFor(row.daily_remaining, row.daily_limit);
    if (state !== row.state) {
      await query(`UPDATE provider_quota SET state = $3 WHERE provider = $1 AND day = $2`, [this.provider, utcDay(), state]);
    }
    const { essentialReserve, backgroundFloor } = this.thresholds(row.daily_limit);
    return {
      provider: row.provider,
      day: utcDay(new Date(row.day)),
      dailyLimit: row.daily_limit,
      dailyUsed: row.daily_used,
      dailyRemaining: row.daily_remaining,
      minuteLimit: row.minute_limit,
      minuteUsed: row.minute_used,
      minuteRemaining: row.minute_remaining,
      state,
      essentialReserve,
      backgroundFloor,
      lastUpdatedAt: row.last_updated_at ? new Date(row.last_updated_at).toISOString() : null,
      reconciledAt: row.reconciled_at ? new Date(row.reconciled_at).toISOString() : null,
    };
  }

  /**
   * Class-aware gating for a task type (or explicit class):
   *   essential  → allowed unless the provider quota is EXHAUSTED
   *   background → allowed only while state is NORMAL
   */
  async allows(taskTypeOrClass: string | TaskClass): Promise<QuotaGate> {
    const s = await this.status();
    const cls: TaskClass =
      taskTypeOrClass === 'essential' || taskTypeOrClass === 'background'
        ? taskTypeOrClass
        : taskClassFor(taskTypeOrClass);
    const allowed = cls === 'essential' ? s.state !== 'EXHAUSTED' && s.dailyRemaining > 0 : s.state === 'NORMAL';
    return {
      allowed,
      class: cls,
      state: s.state,
      dailyRemaining: s.dailyRemaining,
      essentialReserve: s.essentialReserve,
      backgroundFloor: s.backgroundFloor,
    };
  }

  /**
   * Backoff for quota-deferred tasks: 5 min → 10 → 20 → 40 → 60 (cap), with
   * jitter. Deferred tasks are rescheduled, never rapidly retried.
   */
  deferDelaySeconds(defers: number): number {
    const base = 300 * 2 ** Math.min(Math.max(defers, 0), 6);
    return Math.min(base, 3600) + Math.floor(Math.random() * 60);
  }

  async hasQuota(): Promise<boolean> {
    const s = await this.status();
    return s.dailyRemaining > 0 && s.minuteRemaining > 0;
  }

  /**
   * Minute-window throttling: when the per-minute budget is spent but daily
   * quota remains, wait for the window to roll instead of failing the task.
   * Hard-stops only when the daily budget is gone.
   */
  async waitForCapacity(): Promise<void> {
    await this.rollMinuteWindow();
    let s = await this.status();
    if (s.dailyRemaining <= 0) {
      throw new Error('Provider daily quota exhausted');
    }
    let guard = 0;
    while (s.minuteRemaining <= 0 && guard < 70) {
      await new Promise((r) => setTimeout(r, 1000));
      await this.rollMinuteWindow();
      s = await this.status();
      guard += 1;
    }
    if (s.minuteRemaining <= 0) throw new Error('Provider minute rate limit still exhausted after waiting');
  }
}

export const quotaManager = new QuotaManager();
