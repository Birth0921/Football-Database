import type { FastifyInstance } from 'fastify';
import { query } from '../../db/pool.js';
import { ok, fail } from '../../util/http.js';
import { toCamel, toCamelList } from '../shape.js';
import { cacheGetJson, cacheSetJson } from '../../redis/client.js';
import { computeH2H } from '../../analytics/h2h.js';

async function resolveCs(competition?: unknown, season?: unknown): Promise<number | null> {
  if (competition && season) {
    return (
      await query<{ id: number }>(
        `SELECT cs.id FROM competition_seasons cs
         JOIN competitions c ON c.id = cs.competition_id JOIN seasons s ON s.id = cs.season_id
         WHERE (c.id = $1 OR c.provider_id = $1) AND s.year = $2`,
        [Number(competition), Number(season)],
      )
    ).rows[0]?.id ?? null;
  }
  if (competition) {
    return (
      await query<{ id: number }>(
        `SELECT cs.id FROM competition_seasons cs
         JOIN competitions c ON c.id = cs.competition_id
         WHERE (c.id = $1 OR c.provider_id = $1) AND cs.is_current LIMIT 1`,
        [Number(competition)],
      )
    ).rows[0]?.id ?? null;
  }
  return (await query<{ id: number }>(`SELECT id FROM competition_seasons WHERE is_current ORDER BY id DESC LIMIT 1`)).rows[0]?.id ?? null;
}

export function registerStatisticsRoutes(app: FastifyInstance): void {
  // team statistics (team + competition + season)
  app.get('/teams/:id/statistics', { config: { scope: 'statistics:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, unknown>;
    const teamId = (
      await query<{ id: number }>(`SELECT id FROM teams WHERE id = $1 OR (provider='api-football' AND provider_id = $1)`, [Number(id)])
    ).rows[0]?.id;
    if (!teamId) return fail(404, 'team not found');

    const cs = await resolveCs(q.competition, q.season);
    const cacheKey = `api:team-stats:${teamId}:${cs ?? 'none'}`;
    const cached = await cacheGetJson<unknown>(cacheKey);
    if (cached) return ok(cached);

    if (!cs) return fail(404, 'no competition season in scope; import data first');
    const rows = (
      await query<Record<string, unknown>>(
        `SELECT ts.*, c.name AS competition, s.year AS season
         FROM team_statistics ts
         JOIN competition_seasons css ON css.id = ts.competition_season_id
         JOIN competitions c ON c.id = css.competition_id
         JOIN seasons s ON s.id = css.season_id
         WHERE ts.competition_season_id = $1 AND ts.team_id = $2`,
        [cs, teamId],
      )
    ).rows[0];
    if (!rows) return fail(404, 'no statistics stored yet for this team/season (sync pending or team not in scope)');
    const h2hTargets = (
      await query<{ opponent_id: number }>(
        `SELECT DISTINCT CASE WHEN home_team_id = $2 THEN away_team_id ELSE home_team_id END AS opponent_id
         FROM fixtures WHERE competition_season_id = $1 AND (home_team_id = $2 OR away_team_id = $2) LIMIT 6`,
        [cs, teamId],
      )
    ).rows;
    await cacheSetJson(cacheKey, toCamel(rows), 300);
    return ok({ ...toCamel(rows), topOpponents: h2hTargets.map((t) => t.opponent_id) });
  });

  // player statistics (player + season)
  app.get('/players/:id/statistics', { config: { scope: 'statistics:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, unknown>;
    const playerId = (
      await query<{ id: number }>(`SELECT id FROM players WHERE id = $1 OR (provider='api-football' AND provider_id = $1)`, [Number(id)])
    ).rows[0]?.id;
    if (!playerId) return fail(404, 'player not found');
    const seasonFilter = q.season ? Number(q.season) : null;
    const rows = (
      await query<Record<string, unknown>>(
        `SELECT pss.*, s.year AS season, c.name AS competition, t.name AS team,
                (t.name IS NULL) AS is_aggregate
         FROM player_season_statistics pss
         JOIN competition_seasons cs ON cs.id = pss.competition_season_id
         JOIN seasons s ON s.id = cs.season_id
         JOIN competitions c ON c.id = cs.competition_id
         LEFT JOIN teams t ON t.id = pss.team_id
         WHERE pss.player_id = $1 ${seasonFilter ? 'AND s.year = $2' : ''}
         ORDER BY s.year DESC, is_aggregate, t.name`,
        seasonFilter ? [playerId, seasonFilter] : [playerId],
      )
    ).rows;
    if (!rows.length) return fail(404, 'no season statistics stored yet for this player (deep sync pending)');
    return ok(toCamelList(rows));
  });

  // referee statistics (with optional competition/season filter)
  app.get('/referees/:id/statistics', { config: { scope: 'statistics:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, unknown>;
    const refereeId = Number(id);
    const exists = (await query(`SELECT 1 FROM referees WHERE id = $1`, [refereeId])).rowCount;
    if (!exists) return fail(404, 'referee not found');

    const season = q.season ? Number(q.season) : null;
    const competition = q.competition ? Number(q.competition) : null;
    const perSeason = (
      await query<Record<string, unknown>>(
        `SELECT rss.*, s.year AS season, c.name AS competition
         FROM referee_season_statistics rss
         JOIN competition_seasons cs ON cs.id = rss.competition_season_id
         JOIN seasons s ON s.id = cs.season_id
         JOIN competitions c ON c.id = cs.competition_id
         WHERE rss.referee_id = $1
           ${season ? 'AND s.year = $2' : ''} ${competition ? 'AND c.id = $3' : ''}
         ORDER BY s.year DESC`,
        season && competition ? [refereeId, season, competition] : season ? [refereeId, season] : competition ? [refereeId, competition] : [refereeId],
      )
    ).rows;
    const perCompetition = (
      await query<Record<string, unknown>>(
        `SELECT rcs.*, c.name AS competition
         FROM referee_competition_statistics rcs
         JOIN competitions c ON c.id = rcs.competition_id
         WHERE rcs.referee_id = $1 ORDER BY rcs.matches DESC`,
        [refereeId],
      )
    ).rows;
    const recent = (
      await query<Record<string, unknown>>(
        `SELECT rms.*, c.name AS competition, ht.name AS home_team, at2.name AS away_team,
                rms.home_goals, rms.away_goals, rms.match_date
         FROM referee_match_statistics rms
         LEFT JOIN competitions c ON c.id = rms.competition_id
         LEFT JOIN teams ht ON ht.id = rms.home_team_id
         LEFT JOIN teams at2 ON at2.id = rms.away_team_id
         WHERE rms.referee_id = $1
         ORDER BY rms.match_date DESC NULLS LAST LIMIT 20`,
        [refereeId],
      )
    ).rows;
    return ok({ perSeason: toCamelList(perSeason), perCompetition: toCamelList(perCompetition), recentMatches: toCamelList(recent) });
  });

  // competition statistics
  app.get('/competitions/:id/statistics', { config: { scope: 'statistics:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, unknown>;
    const cs = await resolveCs(id, q.season);
    if (!cs) return fail(404, 'competition/season not in scope');
    const stats = (
      await query<Record<string, unknown>>(
        `SELECT ls.*, c.name AS competition, s.year AS season
         FROM league_statistics ls
         JOIN competition_seasons css ON css.id = ls.competition_season_id
         JOIN competitions c ON c.id = css.competition_id
         JOIN seasons s ON s.id = css.season_id
         WHERE ls.competition_season_id = $1`,
        [cs],
      )
    ).rows[0];
    if (!stats) return fail(404, 'league statistics not computed yet for this season');
    return ok(toCamel(stats));
  });

  // head-to-head statistics (local computation, never provider)
  app.get('/h2h', { config: { scope: 'statistics:read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const teamA = Number(q.team1);
    const teamB = Number(q.team2);
    if (!teamA || !teamB) return fail(400, 'team1 and team2 query parameters are required');
    if (teamA === teamB) return fail(400, 'team1 and team2 must differ');
    const lastN = Math.min(20, Math.max(1, Number(q.last ?? 10)));
    const h2h = await computeH2H(teamA, teamB, lastN, q.competition ? Number(q.competition) : undefined);
    return ok(h2h);
  });
}
