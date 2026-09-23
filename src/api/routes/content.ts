import type { FastifyInstance } from 'fastify';
import { query } from '../../db/pool.js';
import { ok, fail, parsePaging, pageInfo } from '../../util/http.js';
import { toCamel, toCamelList, statusBucket } from '../shape.js';
import { computeH2H } from '../../analytics/h2h.js';

/** Map raw fixture row to API shape. */
function fixtureShape(row: Record<string, unknown>): Record<string, unknown> {
  const out = toCamel(row) ?? {};
  (out as Record<string, unknown>).status = statusBucket(row.status_short as string, Boolean(row.is_finished));
  return out;
}

const FIXTURE_SELECT = `
  SELECT f.id, f.provider_id, f.season_year, f.round_name, f.timezone, f.kickoff_at, f.kickoff_date,
         f.status_short, f.status_long, f.status_elapsed, f.is_finished, f.postponed, f.cancelled,
         f.home_score, f.away_score, f.ht_home_score, f.ht_away_score, f.ft_home_score, f.ft_away_score,
         f.et_home_score, f.et_away_score, f.pen_home_score, f.pen_away_score, f.winner_team_id,
         f.finalized_at, f.updated_at,
         ht.name AS home_team, ht.provider_id AS home_team_provider_id, ht.logo_url AS home_team_logo,
         at2.name AS away_team, at2.provider_id AS away_team_provider_id, at2.logo_url AS away_team_logo,
         c.id AS competition_id, c.name AS competition, c.provider_id AS competition_provider_id, c.logo_url AS competition_logo,
         s.year AS season, r.name AS referee, v.name AS venue, v.city AS venue_city
  FROM fixtures f
  JOIN teams ht ON ht.id = f.home_team_id
  JOIN teams at2 ON at2.id = f.away_team_id
  JOIN competitions c ON c.id = f.competition_id
  JOIN seasons s ON s.year = f.season_year
  LEFT JOIN referees r ON r.id = f.referee_id
  LEFT JOIN venues v ON v.id = f.venue_id`;

function fixtureWhere(q: Record<string, unknown>, params: unknown[]): string {
  const clauses: string[] = [];
  const push = (sql: string, value?: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (q.competition) push(`f.competition_id = ?`, Number(q.competition));
  if (q.league) push(`c.provider_id = ?`, Number(q.league));
  if (q.season) push(`f.season_year = ?`, Number(q.season));
  if (q.team) push(`(f.home_team_id = ? OR f.away_team_id = ?)`, Number(q.team));
  if (q.venue) push(`f.venue_id = ?`, Number(q.venue));
  if (q.referee) push(`r.name_key = ?`, String(q.referee));
  if (q.status) {
    const s = String(q.status);
    if (['scheduled', 'live', 'finished', 'postponed', 'cancelled'].includes(s)) {
      params.push(null);
      const idx = params.length;
      clauses.push(
        s === 'finished' ? `f.is_finished`
        : s === 'live' ? `NOT f.is_finished AND f.status_short IN ('1H','2H','HT','ET','BT','P','LIVE')`
        : s === 'scheduled' ? `NOT f.is_finished AND f.status_short IN ('NS','TBD')`
        : s === 'postponed' ? `f.status_short = 'PST'`
        : `f.status_short IN ('CANC','ABD','SUSP','INT','AWD','WO')`,
      );
      void idx;
      params.pop();
    } else {
      push(`f.status_short = ?`, s);
    }
  }
  if (q.from) push(`f.kickoff_at >= ?::timestamptz`, String(q.from));
  if (q.to) push(`f.kickoff_at <= ?::timestamptz`, String(q.to));
  if (q.date) push(`f.kickoff_date = ?`, String(q.date));
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

export function registerContentRoutes(app: FastifyInstance): void {
  // ---------------- competitions ----------------
  app.get('/competitions', { config: { scope: 'standings:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>);
    const q = req.query as Record<string, unknown>;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.country) { params.push(String(q.country)); clauses.push(`co.name = $${params.length}`); }
    if (q.type) { params.push(String(q.type)); clauses.push(`c.type = $${params.length}`); }
    if (q.search) { params.push(`%${String(q.search)}%`); clauses.push(`c.name ILIKE $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query<Record<string, unknown>>(
      `SELECT c.id, c.provider_id, c.name, c.type, c.logo_url, co.name AS country, co.code AS country_code,
              count(cs.id) AS seasons
       FROM competitions c
       LEFT JOIN countries co ON co.id = c.country_id
       LEFT JOIN competition_seasons cs ON cs.competition_id = c.id
       ${where}
       GROUP BY c.id, co.name, co.code
       ORDER BY c.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    const total = (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM competitions c LEFT JOIN countries co ON co.id = c.country_id ${where}`, params)
    ).rows[0].n;
    return ok(toCamelList(rows), { pagination: pageInfo(page, perPage, parseInt(total, 10)) });
  });

  app.get('/competitions/:id', { config: { scope: 'standings:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT c.*, co.name AS country, co.code AS country_code, co.flag_url
       FROM competitions c LEFT JOIN countries co ON co.id = c.country_id
       WHERE c.id = $1 OR (c.provider = 'api-football' AND c.provider_id = $1)`,
      [Number(id)],
    );
    if (!rows[0]) return fail(404, 'competition not found');
    return ok(toCamel(rows[0]));
  });

  app.get('/competitions/:id/seasons', { config: { scope: 'standings:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT cs.id, s.year, cs.start_date, cs.end_date, cs.is_current, cov.*
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons s ON s.id = cs.season_id
       LEFT JOIN competition_season_coverage cov ON cov.competition_season_id = cs.id
       WHERE c.id = $1 OR (c.provider = 'api-football' AND c.provider_id = $1)
       ORDER BY s.year DESC`,
      [Number(id)],
    );
    if (!rows.length) return fail(404, 'competition not found or has no seasons');
    return ok(toCamelList(rows));
  });

  // ---------------- teams ----------------
  app.get('/teams', { config: { scope: 'teams:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>);
    const q = req.query as Record<string, unknown>;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.country) { params.push(String(q.country)); clauses.push(`co.name = $${params.length}`); }
    if (q.search) { params.push(`%${String(q.search)}%`); clauses.push(`(t.name ILIKE $${params.length} OR t.short_name ILIKE $${params.length})`); }
    if (q.competition) { params.push(Number(q.competition)); clauses.push(`EXISTS (SELECT 1 FROM team_seasons ts2 WHERE ts2.team_id = t.id AND ts2.competition_season_id = $${params.length})`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query<Record<string, unknown>>(
      `SELECT t.id, t.provider_id, t.name, t.short_name, t.code, t.founded, t.is_national, t.logo_url,
              co.name AS country, v.name AS venue_name, v.city AS venue_city, v.capacity AS venue_capacity
       FROM teams t
       LEFT JOIN countries co ON co.id = t.country_id
       LEFT JOIN venues v ON v.id = t.venue_id
       ${where} ORDER BY t.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    const total = (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM teams t LEFT JOIN countries co ON co.id = t.country_id ${where}`, params)
    ).rows[0].n;
    return ok(toCamelList(rows), { pagination: pageInfo(page, perPage, parseInt(total, 10)) });
  });

  app.get('/teams/:id', { config: { scope: 'teams:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT t.*, co.name AS country, co.code AS country_code,
              v.id AS venue_id, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city,
              v.capacity AS venue_capacity, v.surface AS venue_surface, v.image_url AS venue_image
       FROM teams t LEFT JOIN countries co ON co.id = t.country_id LEFT JOIN venues v ON v.id = t.venue_id
       WHERE t.id = $1 OR (t.provider = 'api-football' AND t.provider_id = $1)`,
      [Number(id)],
    );
    if (!rows[0]) return fail(404, 'team not found');
    const team = toCamel(rows[0]);
    const seasons = (
      await query<Record<string, unknown>>(
        `SELECT cs.id, s.year, c.name AS competition, cs.is_current
         FROM team_seasons ts JOIN competition_seasons cs ON cs.id = ts.competition_season_id
         JOIN seasons s ON s.id = cs.season_id JOIN competitions c ON c.id = cs.competition_id
         WHERE ts.team_id = $1 ORDER BY s.year DESC, c.name`,
        [rows[0].id],
      )
    ).rows;
    (team as Record<string, unknown>).seasons = toCamelList(seasons);
    return ok(team);
  });

  // ---------------- players ----------------
  app.get('/players', { config: { scope: 'players:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>);
    const q = req.query as Record<string, unknown>;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.search) { params.push(`%${String(q.search)}%`); clauses.push(`p.name ILIKE $${params.length}`); }
    if (q.nationality) { params.push(String(q.nationality)); clauses.push(`co.name = $${params.length}`); }
    if (q.team) {
      params.push(Number(q.team));
      clauses.push(`EXISTS (SELECT 1 FROM player_team_history pth WHERE pth.player_id = p.id AND pth.team_id = $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query<Record<string, unknown>>(
      `SELECT p.id, p.provider_id, p.name, p.firstname, p.lastname, p.birth_date, p.age, p.height_cm, p.weight_kg,
              p.injured, p.photo_url, co.name AS nationality
       FROM players p LEFT JOIN countries co ON co.id = p.nationality_country_id
       ${where} ORDER BY p.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    const total = (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM players p LEFT JOIN countries co ON co.id = p.nationality_country_id ${where}`, params)
    ).rows[0].n;
    return ok(toCamelList(rows), { pagination: pageInfo(page, perPage, parseInt(total, 10)) });
  });

  app.get('/players/:id', { config: { scope: 'players:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT p.*, co.name AS nationality, bc.name AS birth_country
       FROM players p
       LEFT JOIN countries co ON co.id = p.nationality_country_id
       LEFT JOIN countries bc ON bc.id = p.birth_country_id
       WHERE p.id = $1 OR (p.provider = 'api-football' AND p.provider_id = $1)`,
      [Number(id)],
    );
    if (!rows[0]) return fail(404, 'player not found');
    const player = toCamel(rows[0]);
    const teams = (
      await query<Record<string, unknown>>(
        `SELECT t.id, t.name, s.year, c.name AS competition
         FROM player_team_history pth
         JOIN teams t ON t.id = pth.team_id
         LEFT JOIN competition_seasons cs ON cs.id = pth.competition_season_id
         LEFT JOIN seasons s ON s.id = cs.season_id
         LEFT JOIN competitions c ON c.id = cs.competition_id
         WHERE pth.player_id = $1 ORDER BY s.year DESC NULLS LAST, t.name`,
        [rows[0].id],
      )
    ).rows;
    (player as Record<string, unknown>).teams = toCamelList(teams);
    return ok(player);
  });

  // ---------------- referees ----------------
  app.get('/referees', { config: { scope: 'referees:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>);
    const q = req.query as Record<string, unknown>;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.search) { params.push(`%${String(q.search)}%`); clauses.push(`r.name ILIKE $${params.length}`); }
    if (q.country) { params.push(String(q.country)); clauses.push(`co.name = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query<Record<string, unknown>>(
      `SELECT r.id, r.name, co.name AS nationality,
              (SELECT count(*) FROM fixtures f WHERE f.referee_id = r.id)::int AS matches
       FROM referees r LEFT JOIN countries co ON co.id = r.nationality_country_id
       ${where} ORDER BY matches DESC, r.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    const total = (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM referees r LEFT JOIN countries co ON co.id = r.nationality_country_id ${where}`, params)
    ).rows[0].n;
    return ok(toCamelList(rows), { pagination: pageInfo(page, perPage, parseInt(total, 10)) });
  });

  app.get('/referees/:id', { config: { scope: 'referees:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT r.id, r.name, r.firstname, r.lastname, co.name AS nationality
       FROM referees r LEFT JOIN countries co ON co.id = r.nationality_country_id
       WHERE r.id = $1`,
      [Number(id)],
    );
    if (!rows[0]) return fail(404, 'referee not found');
    return ok(toCamel(rows[0]));
  });

  // ---------------- fixtures ----------------
  app.get('/fixtures', { config: { scope: 'fixtures:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>, 25, 100);
    const params: unknown[] = [];
    const where = fixtureWhere(req.query as Record<string, unknown>, params);
    const { rows } = await query<Record<string, unknown>>(
      `${FIXTURE_SELECT}${where} ORDER BY f.kickoff_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    const total = (await query<{ n: string }>(`SELECT count(*)::text AS n FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id JOIN competitions c ON c.id=f.competition_id JOIN seasons s ON s.year=f.season_year LEFT JOIN referees r ON r.id=f.referee_id LEFT JOIN venues v ON v.id=f.venue_id${where}`, params)).rows[0].n;
    return ok(rows.map(fixtureShape), { pagination: pageInfo(page, perPage, parseInt(total, 10)) });
  });

  app.get('/fixtures/upcoming', { config: { scope: 'fixtures:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>, 25, 100);
    const params: unknown[] = [];
    const where = `${fixtureWhere(req.query as Record<string, unknown>, params)}${params.length ? ' AND' : ' WHERE'} f.kickoff_at > now() AND NOT f.is_finished AND NOT f.cancelled`;
    const { rows } = await query<Record<string, unknown>>(
      `${FIXTURE_SELECT}${where} ORDER BY f.kickoff_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    return ok(rows.map(fixtureShape), { pagination: pageInfo(page, perPage, rows.length) });
  });

  app.get('/fixtures/live', { config: { scope: 'fixtures:read' } }, async () => {
    const { rows } = await query<Record<string, unknown>>(
      `${FIXTURE_SELECT} WHERE NOT f.is_finished AND f.status_short IN ('1H','2H','HT','ET','BT','P','LIVE') ORDER BY f.kickoff_at ASC LIMIT 200`,
    );
    return ok(rows.map(fixtureShape));
  });

  app.get('/fixtures/finished', { config: { scope: 'fixtures:read' } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>, 25, 100);
    const params: unknown[] = [];
    const baseWhere = fixtureWhere(req.query as Record<string, unknown>, params);
    const where = `${baseWhere}${params.length ? ' AND' : ' WHERE'} f.is_finished`;
    const { rows } = await query<Record<string, unknown>>(
      `${FIXTURE_SELECT}${where} ORDER BY f.kickoff_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset],
    );
    return ok(rows.map(fixtureShape), { pagination: pageInfo(page, perPage, rows.length) });
  });

  app.get('/fixtures/:id', { config: { scope: 'fixtures:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(`${FIXTURE_SELECT} WHERE f.id = $1 OR f.provider_id = $1`, [Number(id)]);
    if (!rows[0]) return fail(404, 'fixture not found');
    return ok(fixtureShape(rows[0]));
  });

  app.get('/fixtures/:id/events', { config: { scope: 'fixtures:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT e.id, e.event_type AS type, e.event_detail AS detail, e.comments, e.minute, e.extra_minute,
              e.is_var, e.sort_order, e.player_name AS player, e.assist_name AS assist,
              t.name AS team, t.id AS team_id, p.name AS player_resolved, pa.name AS assist_resolved
       FROM fixture_events e
       LEFT JOIN teams t ON t.id = e.team_id
       LEFT JOIN players p ON p.id = e.player_id
       LEFT JOIN players pa ON pa.id = e.assist_player_id
       WHERE e.fixture_id = $1
       ORDER BY e.sort_order, e.minute, e.extra_minute`,
      [Number(id)],
    );
    if (!rows.length) {
      const exists = (await query(`SELECT 1 FROM fixtures WHERE id = $1`, [Number(id)])).rowCount;
      if (!exists) return fail(404, 'fixture not found');
    }
    return ok(toCamelList(rows));
  });

  app.get('/fixtures/:id/statistics', { config: { scope: 'statistics:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT ts.*, t.name AS team, t.provider_id AS team_provider_id
       FROM fixture_team_statistics ts JOIN teams t ON t.id = ts.team_id
       WHERE ts.fixture_id = $1`,
      [Number(id)],
    );
    if (!rows.length) {
      const exists = (await query(`SELECT 1 FROM fixtures WHERE id = $1`, [Number(id)])).rowCount;
      if (!exists) return fail(404, 'fixture not found');
    }
    return ok(toCamelList(rows));
  });

  app.get('/fixtures/:id/lineups', { config: { scope: 'fixtures:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lineups = (
      await query<Record<string, unknown>>(
        `SELECT l.id, l.formation, l.coach_name, t.name AS team, t.id AS team_id
         FROM lineups l JOIN teams t ON t.id = l.team_id WHERE l.fixture_id = $1`,
        [Number(id)],
      )
    ).rows;
    if (!lineups.length) {
      const exists = (await query(`SELECT 1 FROM fixtures WHERE id = $1`, [Number(id)])).rowCount;
      if (!exists) return fail(404, 'fixture not found');
      return ok([]);
    }
    const result = [];
    for (const l of lineups) {
      const players = (
        await query<Record<string, unknown>>(
          `SELECT lp.player_name AS name, lp.shirt_number AS number, lp.position, lp.grid_position AS grid,
                  lp.is_starting, lp.is_captain, p.id AS player_id
           FROM lineup_players lp LEFT JOIN players p ON p.id = lp.player_id
           WHERE lp.lineup_id = $1 ORDER BY lp.is_starting DESC, lp.grid_position`,
          [l.id],
        )
      ).rows;
      result.push({
        team: l.team,
        formation: l.formation,
        coach: l.coach_name,
        startXI: players.filter((p) => p.is_starting),
        substitutes: players.filter((p) => !p.is_starting),
      });
    }
    return ok(result);
  });

  app.get('/fixtures/:id/players', { config: { scope: 'players:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<Record<string, unknown>>(
      `SELECT pms.*, p.name AS player, p.photo_url, t.name AS team, p.provider_id AS player_provider_id
       FROM player_match_statistics pms
       JOIN players p ON p.id = pms.player_id
       JOIN teams t ON t.id = pms.team_id
       WHERE pms.fixture_id = $1
       ORDER BY t.name, pms.minutes_played DESC NULLS LAST`,
      [Number(id)],
    );
    if (!rows.length) {
      const exists = (await query(`SELECT 1 FROM fixtures WHERE id = $1`, [Number(id)])).rowCount;
      if (!exists) return fail(404, 'fixture not found');
    }
    return ok(toCamelList(rows));
  });

  app.get('/fixtures/:id/h2h', { config: { scope: 'fixtures:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fx = (await query<{ home_team_id: number; away_team_id: number; competition_id: number }>(
      `SELECT home_team_id, away_team_id, competition_id FROM fixtures WHERE id = $1`, [Number(id)],
    )).rows[0];
    if (!fx) return fail(404, 'fixture not found');
    const h2h = await computeH2H(fx.home_team_id, fx.away_team_id, 20);
    return ok(h2h);
  });

  // ---------------- standings ----------------
  app.get('/standings', { config: { scope: 'standings:read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    let competitionSeasonId: number | null = null;
    let groupName = String(q.group ?? 'default');
    if (q.competitionSeason) competitionSeasonId = Number(q.competitionSeason);
    else if (q.competition && q.season) {
      competitionSeasonId = (
        await query<{ id: number }>(
          `SELECT cs.id FROM competition_seasons cs JOIN competitions c ON c.id = cs.competition_id JOIN seasons s ON s.id = cs.season_id
           WHERE c.provider_id = $1 AND s.year = $2`,
          [Number(q.competition), Number(q.season)],
        )
      ).rows[0]?.id ?? null;
    } else {
      // default: current season of first current competition
      competitionSeasonId = (
        await query<{ id: number }>(`SELECT cs.id FROM competition_seasons cs WHERE cs.is_current ORDER BY cs.id LIMIT 1`)
      ).rows[0]?.id ?? null;
    }
    if (!competitionSeasonId) return fail(404, 'no standings for the requested competition/season');

    const standings = (
      await query<Record<string, unknown>>(`SELECT id, group_name FROM standings WHERE competition_season_id = $1`, [competitionSeasonId])
    ).rows;
    if (!standings.length) return fail(404, 'no standings stored for this competition/season yet');
    if (!q.group && standings.length === 1) groupName = String(standings[0].group_name);

    const rows = (
      await query<Record<string, unknown>>(
        `SELECT sr.rank, sr.points, sr.played, sr.wins, sr.draws, sr.losses, sr.goals_for, sr.goals_against,
                sr.goal_difference, sr.form, sr.description,
                sr.home_played, sr.home_wins, sr.home_draws, sr.home_losses, sr.home_goals_for, sr.home_goals_against,
                sr.away_played, sr.away_wins, sr.away_draws, sr.away_losses, sr.away_goals_for, sr.away_goals_against,
                t.id AS team_id, t.name AS team, t.logo_url
         FROM standing_rows sr JOIN teams t ON t.id = sr.team_id
         WHERE sr.standings_id = (SELECT id FROM standings WHERE competition_season_id = $1 AND group_name = $2)
         ORDER BY sr.rank`,
        [competitionSeasonId, groupName],
      )
    ).rows;
    return ok({ competitionSeasonId, group: groupName, standings: toCamelList(rows) });
  });
}
