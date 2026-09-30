/**
 * League baselines: what an average match looks like in a competition-season.
 *
 * Fetched once per (competition, season) from `GET /competitions/:id/statistics`
 * and cached in memory — one request per competition instead of one per fixture.
 */
import type { FootballDataClient, LeagueSeasonStats } from '@football-data-platform/client';
import type { LeagueBaseline } from './types.js';

const DEFAULT_GOALS_PER_MATCH = 2.6;
const DEFAULT_HOME_ADVANTAGE_RATIO = 1.25;

export interface BaselineOptions {
  /** Cache lifetime in ms (the platform caches these for 15 min). */
  ttlMs?: number;
  /** Home/away goal ratio used when the league endpoint has no data yet. */
  fallbackHomeAdvantageRatio?: number;
}

function num(value: unknown, fallback: number | null = null): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : null;
  return n !== null && Number.isFinite(n) ? n : fallback;
}

export class LeagueBaselineCache {
  private readonly client: FootballDataClient;
  private readonly ttlMs: number;
  private readonly fallbackRatio: number;
  private readonly cache = new Map<string, { value: LeagueBaseline; expires: number }>();

  constructor(client: FootballDataClient, options: BaselineOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.fallbackRatio = options.fallbackHomeAdvantageRatio ?? DEFAULT_HOME_ADVANTAGE_RATIO;
  }

  /** Baseline for a competition-season; falls back to league-average defaults. */
  async get(competitionId: number, seasonId: number, featuresLeagueAvgGoals?: number | null): Promise<LeagueBaseline> {
    const key = `${competitionId}:${seasonId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    let baseline: LeagueBaseline;
    try {
      const { data } = await this.client.competitionStatistics(competitionId, seasonId);
      baseline = this.fromStats(competitionId, seasonId, data, featuresLeagueAvgGoals);
    } catch {
      baseline = this.fallback(competitionId, seasonId, featuresLeagueAvgGoals);
    }
    this.cache.set(key, { value: baseline, expires: Date.now() + this.ttlMs });
    return baseline;
  }

  private fromStats(
    competitionId: number,
    seasonId: number,
    stats: LeagueSeasonStats,
    featuresLeagueAvgGoals?: number | null,
  ): LeagueBaseline {
    const goalsPerMatch = num(stats.goals_per_match) ?? featuresLeagueAvgGoals ?? DEFAULT_GOALS_PER_MATCH;
    const completed = num(stats.completed_matches) ?? num(stats.matches) ?? 0;
    const homeGoals = num(stats.home_goals);
    const awayGoals = num(stats.away_goals);
    if (completed >= 6 && homeGoals !== null && awayGoals !== null) {
      return {
        competitionId,
        seasonId,
        goalsPerMatch,
        homeGoalsPerMatch: homeGoals / completed,
        awayGoalsPerMatch: awayGoals / completed,
        completedMatches: completed,
        source: 'api',
      };
    }
    return this.fallback(competitionId, seasonId, goalsPerMatch);
  }

  private fallback(competitionId: number, seasonId: number, goalsPerMatch?: number | null): LeagueBaseline {
    const gpm = goalsPerMatch && goalsPerMatch > 0 ? goalsPerMatch : DEFAULT_GOALS_PER_MATCH;
    const ratio = this.fallbackRatio;
    return {
      competitionId,
      seasonId,
      goalsPerMatch: gpm,
      homeGoalsPerMatch: (gpm * ratio) / (1 + ratio),
      awayGoalsPerMatch: gpm / (1 + ratio),
      completedMatches: null,
      source: 'fallback',
    };
  }
}
