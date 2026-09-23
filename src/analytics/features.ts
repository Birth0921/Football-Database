import { query } from '../db/pool.js';
import { cacheGetJson, cacheSetJson, cacheDelPattern } from '../redis/client.js';
import { computeH2H } from './h2h.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'features' });

const FEATURES_VERSION = 1;

export interface FixtureFeatureContext {
  fixtureId: number;
  competitionSeasonId: number;
  homeTeamId: number;
  awayTeamId: number;
  refereeId: number | null;
}

async function loadFixtureContext(fixtureId: number): Promise<FixtureFeatureContext | null> {
  const { rows } = await query<FixtureFeatureContext>(
    `SELECT id AS "fixtureId", competition_season_id AS "competitionSeasonId",
            home_team_id AS "homeTeamId", away_team_id AS "awayTeamId", referee_id AS "refereeId"
     FROM fixtures WHERE id = $1`,
    [fixtureId],
  );
  return rows[0] ?? null;
}

/**
 * Build the complete prediction feature set for a fixture from local data only.
 * Cached in Redis (upcoming fixtures change slowly) and persisted to prediction_features.
 */
export async function buildPredictionFeatures(fixtureId: number, opts: { persist?: boolean } = {}): Promise<Record<string, unknown> | null> {
  const ctx = await loadFixtureContext(fixtureId);
  if (!ctx) return null;

  const cacheKey = `features:fixture:${fixtureId}`;
  if (opts.persist !== false) {
    const cached = await cacheGetJson<Record<string, unknown>>(cacheKey);
    if (cached) return cached;
  }

  const [fixtureMeta] = (
    await query(
      `SELECT f.id, f.kickoff_at AS "kickoffAt", f.status_short AS "status", f.round_name AS round,
              c.name AS competition, c.id AS "competitionId", s.year AS season,
              ht.name AS "homeTeam", at2.name AS "awayTeam",
              ht.id AS "homeTeamId", at2.id AS "awayTeamId",
              v.name AS venue, r.name AS referee
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons s ON s.year = f.season_year
       JOIN teams ht ON ht.id = f.home_team_id
       JOIN teams at2 ON at2.id = f.away_team_id
       LEFT JOIN venues v ON v.id = f.venue_id
       LEFT JOIN referees r ON r.id = f.referee_id
       WHERE f.id = $1`,
      [fixtureId],
    )
  ).rows;

  const homeStats = (
    await query(`SELECT * FROM team_statistics WHERE competition_season_id = $1 AND team_id = $2`, [ctx.competitionSeasonId, ctx.homeTeamId])
  ).rows[0] ?? null;
  const awayStats = (
    await query(`SELECT * FROM team_statistics WHERE competition_season_id = $1 AND team_id = $2`, [ctx.competitionSeasonId, ctx.awayTeamId])
  ).rows[0] ?? null;
  const leagueStats = (
    await query(`SELECT * FROM league_statistics WHERE competition_season_id = $1`, [ctx.competitionSeasonId])
  ).rows[0] ?? null;

  let refereeStats = null;
  if (ctx.refereeId) {
    refereeStats = (
      await query(
        `SELECT matches, yellow_cards, yellow_cards_per_match, red_cards, red_cards_per_match,
                total_cards, cards_per_match, fouls, fouls_per_match, penalties, penalties_per_match,
                home_team_cards, away_team_cards, last5, last10, last20, last_calculated_at
         FROM referee_season_statistics WHERE referee_id = $1 ORDER BY last_calculated_at DESC LIMIT 1`,
        [ctx.refereeId],
      )
    ).rows[0] ?? null;
  }

  const injuries = (
    await query(
      `SELECT sr.record_type, sr.reason, sr.end_date, p.name AS player, p.id AS "playerId", t.name AS team
       FROM sidelined_records sr
       JOIN players p ON p.id = sr.player_id
       LEFT JOIN teams t ON t.id = sr.team_id
       WHERE sr.team_id IN ($1, $2)
         AND (sr.end_date IS NULL OR sr.end_date >= (SELECT kickoff_date FROM fixtures WHERE id = $3))
       ORDER BY p.name`,
      [ctx.homeTeamId, ctx.awayTeamId, fixtureId],
    )
  ).rows;

  const h2h = await computeH2H(ctx.homeTeamId, ctx.awayTeamId, 10);

  const features = {
    version: FEATURES_VERSION,
    fixture: fixtureMeta ?? { id: fixtureId },
    homeRecentForm: (homeStats as Record<string, unknown> | null)?.form_last10 ?? null,
    awayRecentForm: (awayStats as Record<string, unknown> | null)?.form_last10 ?? null,
    home: {
      teamId: ctx.homeTeamId,
      overall: stripDerived(homeStats),
      homeSpecific: pickHomeAway(homeStats, 'home'),
    },
    away: {
      teamId: ctx.awayTeamId,
      overall: stripDerived(awayStats),
      awaySpecific: pickHomeAway(awayStats, 'away'),
    },
    league: stripDerived(leagueStats),
    referee: refereeStats,
    playerAvailability: {
      home: injuries.filter((i) => i.team === fixtureMeta?.homeTeam),
      away: injuries.filter((i) => i.team === fixtureMeta?.awayTeam),
    },
    h2h: {
      summary: {
        matches: h2h.matches,
        homeTeamWins: h2h.homeWins,
        draws: h2h.draws,
        awayTeamWins: h2h.awayWins,
        goals: { [String(ctx.homeTeamId)]: h2h.teamAGoals, [String(ctx.awayTeamId)]: h2h.teamBGoals },
        btts: h2h.btts,
        cleanSheets: h2h.cleanSheets,
      },
      last5: h2h.recent.slice(0, 5),
      last10: h2h.recent,
    },
    dataFreshness: {
      teamStatistics: homeStats?.last_calculated_at ?? awayStats?.last_calculated_at ?? null,
      leagueStatistics: leagueStats?.last_calculated_at ?? null,
      refereeStatistics: refereeStats?.last_calculated_at ?? null,
      computedAt: new Date().toISOString(),
    },
  };

  if (opts.persist !== false) {
    await query(
      `INSERT INTO prediction_features (fixture_id, version, features, computed_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (fixture_id) DO UPDATE SET version = EXCLUDED.version, features = EXCLUDED.features, computed_at = now()`,
      [fixtureId, FEATURES_VERSION, JSON.stringify(features)],
    );
    await cacheSetJson(cacheKey, features, 15 * 60);
  }
  return features;
}

function stripDerived(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null;
  const r = { ...(row as Record<string, unknown>) };
  delete r.id;
  delete r.last_calculated_at;
  return camelKeys(r);
}

function pickHomeAway(row: unknown, side: 'home' | 'away'): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const prefix = side === 'home' ? 'home_' : 'away_';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  if ('form_last10' in r) out.recentForm = r.form_last10;
  return out;
}

function camelKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = v;
  }
  return out;
}

/** Rebuild features for all upcoming fixtures of a competition season (or all). */
export async function rebuildUpcomingFeatures(competitionSeasonId?: number): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `SELECT f.id FROM fixtures f
     WHERE f.kickoff_at > now() - interval '3 hours' AND f.is_finished = FALSE
       ${competitionSeasonId ? 'AND f.competition_season_id = $1' : ''}
     ORDER BY f.kickoff_at ASC
     LIMIT 2000`,
    competitionSeasonId ? [competitionSeasonId] : [],
  );
  let n = 0;
  for (const r of rows) {
    try {
      await buildPredictionFeatures(r.id);
      n++;
    } catch (err) {
      log.warn({ fixtureId: r.id, err: err instanceof Error ? err.message : err }, 'feature build failed');
    }
  }
  log.info({ rebuilt: n }, 'prediction features rebuilt');
  return n;
}

export async function invalidateFixtureCache(fixtureId: number): Promise<void> {
  await cacheDelPattern(`features:fixture:${fixtureId}`);
  await cacheDelPattern(`api:fixture:${fixtureId}*`);
}
