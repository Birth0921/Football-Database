import { query, queryOne } from '../lib/db.js';
import { config } from '../config.js';

export type QuotaState = 'NORMAL' | 'CAUTION' | 'CRITICAL';

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
  lastUpdatedAt: string | null;
}

function stateFor(remainingPct: number): QuotaState {
  if (remainingPct < 20) return 'CRITICAL';
  if (remainingPct <= 50) return 'CAUTION';
  return 'NORMAL';
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class QuotaManager {
  constructor(private provider = 'api-football') {}

  async ensureToday(): Promise<void> {
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
    if (typeof dailyRemainingFromHeader === 'number') dailyRemaining = dailyRemainingFromHeader;
    if (typeof minuteRemainingFromHeader === 'number') minuteRemaining = minuteRemainingFromHeader;
    const remainingPct = (dailyRemaining / Math.max(row.daily_limit, 1)) * 100;
    await query(
      `UPDATE provider_quota SET daily_remaining = $3, minute_remaining = $4, state = $5, last_updated_at = now()
        WHERE provider = $1 AND day = $2`,
      [this.provider, utcDay(), dailyRemaining, minuteRemaining, stateFor(remainingPct)],
    );
  }

  /** Provider-reported counters (e.g. from /status) override local counting. */
  async observeExternal(dailyUsed: number | null, dailyLimit: number | null): Promise<void> {
    await this.ensureToday();
    if (dailyUsed === null && dailyLimit === null) return;
    const limit = dailyLimit ?? config.providerDailyQuota;
    const used = dailyUsed ?? 0;
    const remaining = Math.max(limit - used, 0);
    await query(
      `UPDATE provider_quota
          SET daily_limit = $3, daily_used = $4, daily_remaining = $5, state = $6, last_updated_at = now()
        WHERE provider = $1 AND day = $2`,
      [this.provider, utcDay(), limit, used, remaining, stateFor((remaining / Math.max(limit, 1)) * 100)],
    );
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
    }>(`SELECT * FROM provider_quota WHERE provider = $1 AND day = $2`, [this.provider, utcDay()]);
    if (!row) {
      await this.ensureToday();
      return this.status();
    }
    const state = stateFor((row.daily_remaining / Math.max(row.daily_limit, 1)) * 100);
    if (state !== row.state) {
      await query(`UPDATE provider_quota SET state = $3 WHERE provider = $1 AND day = $2`, [this.provider, utcDay(), state]);
    }
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
      lastUpdatedAt: row.last_updated_at ? new Date(row.last_updated_at).toISOString() : null,
    };
  }

  /**
   * Priority gating: CRITICAL keeps live/score/post-match/near-term work,
   * defers low-priority historical/metadata refreshes.
   */
  async shouldDefer(priority: number): Promise<boolean> {
    const s = await this.status();
    if (s.state === 'CRITICAL') return priority > 50;
    if (s.state === 'CAUTION') return priority > 80;
    return false;
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
