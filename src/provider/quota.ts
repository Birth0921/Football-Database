import { config } from '../config.js';
import { cacheGetJson, cacheSetJson, counterGet } from '../redis/client.js';
import { query } from '../db/pool.js';

export type QuotaLevel = 'NORMAL' | 'CAUTION' | 'CRITICAL' | 'NO_KEY' | 'UNKNOWN';

export interface QuotaSnapshot {
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  minuteLimit: number;
  minuteUsed: number;
  minuteRemaining: number;
  level: QuotaLevel;
  lastUpdated: string | null;
  source: string;
}

const QUOTA_CACHE_KEY = 'quota:provider';
const DAILY_COUNTER_PREFIX = 'quota:daily-used';
const MINUTE_COUNTER_PREFIX = 'quota:minute-used';

function levelFor(remainingPct: number, dailyLimit: number): QuotaLevel {
  if (dailyLimit <= 0) return 'UNKNOWN';
  if (remainingPct > 50) return 'NORMAL';
  if (remainingPct >= 20) return 'CAUTION';
  return 'CRITICAL';
}

function currentMinuteKey(): string {
  return new Date().toISOString().slice(0, 16); // minute resolution
}

/** Today's date key (UTC) used for daily counters. */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Quota manager: tracks daily + minute usage against API-Football limits.
 * Sources of truth, in order:
 *  1. provider /status endpoint data (written by the client after each call / periodic check)
 *  2. Redis minute/daily counters (fast path for rate limiting)
 *  3. provider_requests table aggregation (restart-safe fallback)
 */
export const quotaManager = {
  async snapshot(): Promise<QuotaSnapshot> {
    const cached = await cacheGetJson<Partial<QuotaSnapshot> & { ts?: string }>(QUOTA_CACHE_KEY);
    const dailyLimit = cached?.dailyLimit ?? config.provider.dailyLimit;
    const minuteLimit = cached?.minuteLimit ?? config.provider.minuteLimit;

    // fast-path counters
    let dailyUsed = await counterGet(`${DAILY_COUNTER_PREFIX}:${todayKey()}`);
    let minuteUsed = await counterGet(`${MINUTE_COUNTER_PREFIX}:${currentMinuteKey()}`);

    // restart-safe fallback from DB (today's successful provider calls)
    if (dailyUsed === 0) {
      const { rows } = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM provider_requests
         WHERE success = TRUE AND started_at >= date_trunc('day', now())`,
      );
      dailyUsed = parseInt(rows[0]?.n ?? '0', 10);
    }

    const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
    const minuteRemaining = Math.max(0, minuteLimit - minuteUsed);
    const remainingPct = (dailyRemaining / Math.max(1, dailyLimit)) * 100;

    return {
      dailyLimit,
      dailyUsed,
      dailyRemaining,
      minuteLimit,
      minuteUsed,
      minuteRemaining,
      level: !config.provider.key ? 'NO_KEY' : levelFor(remainingPct, dailyLimit),
      lastUpdated: cached?.ts ?? null,
      source: cached?.source ?? 'local',
    };
  },

  /** Update stored snapshot from provider /status response or headers. */
  async updateFromProvider(data: {
    dailyLimit?: number;
    dailyUsed?: number;
    minuteLimit?: number;
    minuteUsed?: number;
    source?: string;
  }): Promise<void> {
    const snapshot = {
      dailyLimit: data.dailyLimit ?? config.provider.dailyLimit,
      minuteLimit: data.minuteLimit ?? config.provider.minuteLimit,
      dailyUsed: data.dailyUsed ?? 0,
      minuteUsed: data.minuteUsed ?? 0,
      ts: new Date().toISOString(),
      source: data.source ?? 'provider',
    };
    await cacheSetJson(QUOTA_CACHE_KEY, snapshot, 120);
  },

  async recordLocalUsage(): Promise<void> {
    // counted lazily in snapshot() from provider_requests; nothing else needed here.
  },

  /** Should a task of the given priority class run right now, given quota state? */
  async allowsPriority(priorityClass: 'live' | 'high' | 'medium' | 'low'): Promise<boolean> {
    const snap = await this.snapshot();
    if (snap.level === 'NO_KEY') return false;
    switch (snap.level) {
      case 'NORMAL':
        return true;
      case 'CAUTION':
        return priorityClass !== 'low';
      case 'CRITICAL':
        return priorityClass === 'live' || priorityClass === 'high';
      default:
        return priorityClass !== 'low';
    }
  },
};

export function priorityClassFor(priority: number): 'live' | 'high' | 'medium' | 'low' {
  if (priority >= 9) return 'live';
  if (priority >= 7) return 'high';
  if (priority >= 4) return 'medium';
  return 'low';
}
