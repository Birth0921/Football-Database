/** Our REST API application (/api/v1). */
import express, { Express, Request } from 'express';
import swaggerUi from 'swagger-ui-express';
import { query, queryOne } from '../lib/db.js';
import { redisPing } from '../lib/redis.js';
import { cacheGet, cacheSet, cacheKeys, CACHE_TTL } from '../lib/cache.js';
import { openapiDoc } from './openapi.js';
import {
  adminLoginHandler, apiKeyAuth, asyncHandler, errorHandler, pagination, paginated, requireAdmin, recordUsageAfter,
} from './middleware.js';
import {
  createClient, createKey, listClients, listKeys, revokeKey, rotateKey, usageReport,
  updateClientLimits, deleteKeyPermanently, ALL_SCOPES,
} from '../keys/service.js';
import { getManagedWebsiteKeyRecord, rotateWebsiteKey } from '../keys/website-key.js';
import { quotaManager } from '../sync/quota.js';
import { NotFoundError, AppError } from '../types.js';
import { config } from '../config.js';
import { runDataQualityChecks } from '../data-quality.js';
import { syncSummary, listFailedTasks, retryFailedTasks } from '../sync/tasks.js';
import { registeredTaskTypes } from '../sync/engine.js';

function scopeFor(req: Request): string | undefined {
  const p = req.path;
  if (p.startsWith('/admin')) return req.method === 'GET' ? 'admin:read' : 'admin:write';
  if (p.startsWith('/predictions')) return 'predictions:read';
  if (p.includes('/statistics') || p.startsWith('/standings')) return 'statistics:read';
  if (p.startsWith('/referees')) return 'referees:read';
  if (p.startsWith('/players')) return 'players:read';
  if (p.startsWith('/teams')) return 'teams:read';
  if (p.startsWith('/fixtures')) return 'fixtures:read';
  if (p.startsWith('/competitions')) return 'teams:read';
  return undefined;
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openapiDoc));

  const v1 = express.Router();
  v1.use(apiKeyAuth(scopeFor));
  v1.use(recordUsageAfter());

  // ---- health -------------------------------------------------------------
  v1.get('/health', (_req, res) => res.json({ ok: true, status: 'alive', time: new Date().toISOString(), providerMode: config.providerMode }));
  v1.get('/health/database', asyncHandler(async (_req, res) => {
    const row = await queryOne<{ one: number }>('SELECT 1 AS one');
    res.json({ ok: Boolean(row), status: row ? 'connected' : 'error' });
  }));
  v1.get('/health/redis', asyncHandler(async (_req, res) => {
    const ok = await redisPing();
    res.status(ok ? 200 : 503).json({ ok, status: ok ? 'connected' : 'unavailable' });
  }));
  v1.get('/health/provider', asyncHandler(async (_req, res) => {
    const quota = await quotaManager.status();
    const recent = await queryOne<{ failed: number }>(
      `SELECT count(*)::int AS failed FROM provider_requests WHERE started_at > now() - interval '1 hour' AND success = FALSE`,
    );
    res.json({ ok: quota.dailyRemaining > 0, mode: config.providerMode, quota, failedRequestsLastHour: recent?.failed ?? 0 });
  }));
  v1.get('/health/data', asyncHandler(async (_req, res) => {
    const result = await runDataQualityChecks({ persist: false });
    res.json({ ok: result.failed === 0, status: result.failed === 0 ? 'PASS' : 'FAIL', checks: result.checks, summary: { passed: result.passed, warnings: result.warnings, failed: result.failed } });
  }));

  // ---- competitions -------------------------------------------------------
  v1.get('/competitions', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const country = req.query.country ? String(req.query.country) : null;
    const cached = await cacheGet<unknown>(cacheKeys.competitions());
    if (cached && !country) return res.json(cached);
    const where = country
      ? `WHERE c.active = TRUE AND c.import_tier BETWEEN 1 AND 3 AND lower(co.name) = lower($1)`
      : `WHERE c.active = TRUE AND c.import_tier BETWEEN 1 AND 3`;
    const total = (await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM competitions c ${country ? 'JOIN countries co ON co.id = c.country_id' : ''} ${where}`,
      country ? [country] : [],
    ))?.c ?? 0;
    const rows = await query(
      `SELECT c.*, co.name AS country_name FROM competitions c
        LEFT JOIN countries co ON co.id = c.country_id ${where}
        ORDER BY c.name ASC LIMIT $${country ? 2 : 1} OFFSET $${country ? 3 : 2}`,
      country ? [country, perPage, offset] : [perPage, offset],
    );
    const body = paginated(rows, total, page, perPage);
    if (!country) await cacheSet(cacheKeys.competitions(), body, CACHE_TTL.lists);
    res.json(body);
  }));
  v1.get('/competitions/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne(`SELECT c.*, co.name AS country_name FROM competitions c LEFT JOIN countries co ON co.id = c.country_id
      WHERE c.id = $1 AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3`, [id]);
    if (!row) throw new NotFoundError(`competition ${id} not found`);
    res.json({ ok: true, data: row });
  }));
  v1.get('/competitions/:id/seasons', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const rows = await query(
      `SELECT se.*, cs.is_current AS linked_current, cs.import_scope,
              to_jsonb(cov) - 'id' - 'competition_season_id' AS coverage
         FROM competition_seasons cs
         JOIN competitions c ON c.id = cs.competition_id
         JOIN seasons se ON se.id = cs.season_id
         LEFT JOIN competition_season_coverage cov ON cov.competition_season_id = cs.id
        WHERE cs.competition_id = $1 AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'
        ORDER BY se.year DESC`,
      [id],
    );
    res.json({ ok: true, data: rows });
  }));
  v1.get('/competitions/:id/statistics', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const seasonId = Number(req.query.season_id);
    if (!seasonId) throw new AppError('season_id query parameter required', 400, 'VALIDATION');
    const row = await queryOne(
      `SELECT lss.* FROM league_season_statistics lss
         JOIN competitions c ON c.id = lss.competition_id
         JOIN seasons se ON se.id = lss.season_id
         JOIN competition_seasons cs ON cs.competition_id = lss.competition_id AND cs.season_id = lss.season_id
        WHERE lss.competition_id = $1 AND lss.season_id = $2
          AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
      [id, seasonId],
    );
    res.json({ ok: true, data: row ?? null });
  }));

  // ---- teams --------------------------------------------------------------
  v1.get('/teams', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const conds: string[] = [
      `EXISTS (
         SELECT 1 FROM team_seasons ts
         JOIN competitions c ON c.id = ts.competition_id
         JOIN seasons se ON se.id = ts.season_id
         JOIN competition_seasons cs ON cs.competition_id = ts.competition_id AND cs.season_id = ts.season_id
        WHERE ts.team_id = t.id AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'
       )`,
    ];
    const params: unknown[] = [];
    if (req.query.competition_id) {
      params.push(Number(req.query.competition_id), Number(req.query.season_id ?? 0));
      conds.push(`EXISTS (
        SELECT 1 FROM team_seasons ts
        JOIN competitions c ON c.id = ts.competition_id
        JOIN seasons se ON se.id = ts.season_id
        JOIN competition_seasons cs ON cs.competition_id = ts.competition_id AND cs.season_id = ts.season_id
        WHERE ts.team_id = t.id AND ts.competition_id = $${params.length - 1}
          AND ($${params.length} = 0 OR ts.season_id = $${params.length})
          AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'
      )`);
    }
    if (req.query.name) {
      params.push(`%${String(req.query.name)}%`);
      conds.push(`t.name ILIKE $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM teams t ${where}`, params))?.c ?? 0;
    params.push(perPage, offset);
    const rows = await query(`SELECT t.* FROM teams t ${where} ORDER BY t.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json(paginated(rows, total, page, perPage));
  }));
  v1.get('/teams/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cached = await cacheGet(cacheKeys.team(id));
    const row = await queryOne(
      `SELECT t.*, v.name AS venue_name, v.city AS venue_city, co.name AS country_name
         FROM teams t LEFT JOIN venues v ON v.id = t.venue_id LEFT JOIN countries co ON co.id = t.country_id
        WHERE t.id = $1
          AND EXISTS (
            SELECT 1 FROM team_seasons ts
            JOIN competitions c ON c.id = ts.competition_id
            JOIN seasons se ON se.id = ts.season_id
            JOIN competition_seasons cs ON cs.competition_id = ts.competition_id AND cs.season_id = ts.season_id
            WHERE ts.team_id = t.id AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
              AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'
          )`,
      [id],
    );
    if (!row) throw new NotFoundError(`team ${id} not found`);
    if (!cached) await cacheSet(cacheKeys.team(id), row, CACHE_TTL.lists);
    res.json({ ok: true, data: row });
  }));
  v1.get('/teams/:id/statistics', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const competitionId = Number(req.query.competition_id);
    const seasonId = Number(req.query.season_id);
    if (!competitionId || !seasonId) throw new AppError('competition_id and season_id query parameters required', 400, 'VALIDATION');
    const row = await queryOne(
      `SELECT stats.* FROM team_competition_season_stats stats
         JOIN competitions c ON c.id = stats.competition_id
         JOIN seasons se ON se.id = stats.season_id
         JOIN competition_seasons cs ON cs.competition_id = stats.competition_id AND cs.season_id = stats.season_id
        WHERE stats.team_id = $1 AND stats.competition_id = $2 AND stats.season_id = $3
          AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
      [id, competitionId, seasonId],
    );
    res.json({ ok: true, data: row ?? null });
  }));

  // ---- players ------------------------------------------------------------
  v1.get('/players', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (req.query.team_id) {
      params.push(Number(req.query.team_id));
      conds.push(`p.current_team_id = $${params.length}`);
    }
    if (req.query.name) {
      params.push(`%${String(req.query.name)}%`);
      conds.push(`p.name ILIKE $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM players p ${where}`, params))?.c ?? 0;
    params.push(perPage, offset);
    const rows = await query(`SELECT p.* FROM players p ${where} ORDER BY p.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json(paginated(rows, total, page, perPage));
  }));
  v1.get('/players/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne(`SELECT p.*, t.name AS team_name FROM players p LEFT JOIN teams t ON t.id = p.current_team_id WHERE p.id = $1`, [id]);
    if (!row) throw new NotFoundError(`player ${id} not found`);
    const history = await query(
      `SELECT h.*, t.name AS team_name FROM player_team_history h JOIN teams t ON t.id = h.team_id WHERE h.player_id = $1 ORDER BY h.start_date DESC NULLS LAST`,
      [id],
    );
    res.json({ ok: true, data: { ...row, teamHistory: history } });
  }));
  v1.get('/players/:id/statistics', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const params: unknown[] = [id];
    let where = `WHERE player_id = $1`;
    if (req.query.competition_id) {
      params.push(Number(req.query.competition_id));
      where += ` AND competition_id = $${params.length}`;
    }
    if (req.query.season_id) {
      params.push(Number(req.query.season_id));
      where += ` AND season_id = $${params.length}`;
    }
    const rows = await query(`SELECT * FROM player_season_statistics ${where} ORDER BY season_id DESC`, params);
    res.json({ ok: true, data: rows });
  }));

  // ---- referees -----------------------------------------------------------
  v1.get('/referees', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const total = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM referees`))?.c ?? 0;
    const rows = await query(`SELECT * FROM referees ORDER BY name ASC LIMIT $1 OFFSET $2`, [perPage, offset]);
    res.json(paginated(rows, total, page, perPage));
  }));
  v1.get('/referees/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne(`SELECT * FROM referees WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError(`referee ${id} not found`);
    res.json({ ok: true, data: row });
  }));
  v1.get('/referees/:id/statistics', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const params: unknown[] = [id];
    let where = `WHERE referee_id = $1`;
    if (req.query.competition_id) {
      params.push(Number(req.query.competition_id));
      where += ` AND competition_id = $${params.length}`;
    }
    if (req.query.season_id) {
      params.push(Number(req.query.season_id));
      where += ` AND season_id = $${params.length}`;
    }
    const [season, competition, recent] = await Promise.all([
      query(`SELECT * FROM referee_season_statistics ${where} ORDER BY season_id DESC`, params),
      query(`SELECT * FROM referee_competition_statistics WHERE referee_id = $1`, [id]),
      query(`SELECT rms.*, f.kickoff_utc, f.status_short FROM referee_match_statistics rms JOIN fixtures f ON f.id = rms.fixture_id WHERE rms.referee_id = $1 ORDER BY f.kickoff_utc DESC NULLS LAST LIMIT 20`, [id]),
    ]);
    res.json({ ok: true, data: { season, competition, recentMatches: recent } });
  }));

  // ---- fixtures -----------------------------------------------------------
  function fixtureFilters(req: Request): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (i: number) => string, v: unknown) => {
      params.push(v);
      conds.push(sql(params.length));
    };
    if (req.query.competition_id) add((i) => `f.competition_id = $${i}`, Number(req.query.competition_id));
    if (req.query.season_id) add((i) => `f.season_id = $${i}`, Number(req.query.season_id));
    if (req.query.team_id) add((i) => `(f.home_team_id = $${i} OR f.away_team_id = $${i})`, Number(req.query.team_id));
    if (req.query.status) add((i) => `f.status_short = $${i}`, String(req.query.status).toUpperCase());
    if (req.query.from) add((i) => `f.kickoff_utc >= $${i}`, String(req.query.from));
    if (req.query.to) add((i) => `f.kickoff_utc <= $${i}::date + interval '1 day'`, String(req.query.to));
    return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  const fixtureJoin = `FROM fixtures f
    LEFT JOIN teams ht ON ht.id = f.home_team_id
    LEFT JOIN teams at ON at.id = f.away_team_id
    JOIN competitions c ON c.id = f.competition_id
      AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
    JOIN seasons se ON se.id = f.season_id AND se.import_scope = 'in_scope'
    JOIN competition_seasons cs ON cs.competition_id = f.competition_id
      AND cs.season_id = f.season_id AND cs.import_scope = 'in_scope'
    LEFT JOIN venues v ON v.id = f.venue_id`;
  const fixtureCols = `f.*, ht.name AS home_team_name, at.name AS away_team_name,
       ht.logo_url AS home_team_logo, at.logo_url AS away_team_logo,
       c.name AS competition_name, se.display_name AS season_name, v.name AS venue_name`;

  v1.get('/fixtures', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const { where, params } = fixtureFilters(req);
    const total = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c ${fixtureJoin} ${where}`, params))?.c ?? 0;
    params.push(perPage, offset);
    const rows = await query(
      `SELECT
       ${fixtureCols}
       ${fixtureJoin} ${where} ORDER BY f.kickoff_utc ASC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paginated(rows, total, page, perPage));
  }));
  v1.get('/fixtures/upcoming', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const total = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c ${fixtureJoin} WHERE f.status_short = 'NS' AND f.kickoff_utc > now()`))?.c ?? 0;
    const rows = await query(
      `SELECT
       ${fixtureCols}
       ${fixtureJoin} WHERE f.status_short = 'NS' AND f.kickoff_utc > now()
       ORDER BY f.kickoff_utc ASC LIMIT $1 OFFSET $2`,
      [perPage, offset],
    );
    res.json(paginated(rows, total, page, perPage));
  }));
  v1.get('/fixtures/live', asyncHandler(async (_req, res) => {
    const cached = await cacheGet(cacheKeys.live());
    if (cached) return res.json({ ok: true, data: cached, cached: true });
    const rows = await query(
      `SELECT
       ${fixtureCols}
       ${fixtureJoin} WHERE f.status_short IN ('1H','HT','2H','ET','BT','P','INT') ORDER BY f.kickoff_utc ASC`,
    );
    await cacheSet(cacheKeys.live(), rows, CACHE_TTL.liveFixtures);
    res.json({ ok: true, data: rows });
  }));
  v1.get('/fixtures/finished', asyncHandler(async (req, res) => {
    const { page, perPage, offset } = pagination(req);
    const day = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const where = `WHERE f.status_short IN ('FT','AET','PEN') AND f.kickoff_utc::date = $1::date`;
    const total = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c ${fixtureJoin} ${where}`, [day]))?.c ?? 0;
    const rows = await query(
      `SELECT
       ${fixtureCols}
       ${fixtureJoin} ${where} ORDER BY f.kickoff_utc DESC LIMIT $2 OFFSET $3`,
      [day, perPage, offset],
    );
    res.json(paginated(rows, total, page, perPage));
  }));

  async function fixtureDetail(id: number) {
    const row = await queryOne(
      `SELECT
       ${fixtureCols},
              r.name AS referee_name
       ${fixtureJoin}
       LEFT JOIN referees r ON r.id = f.referee_id
       WHERE f.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundError(`fixture ${id} not found`);
    return row;
  }

  // NOTE: :id routes registered after the literal routes above
  v1.get('/fixtures/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cached = await cacheGet(cacheKeys.fixture(id));
    const row = await fixtureDetail(id); // scope-check before serving a cached row
    if (cached) return res.json({ ok: true, data: cached, cached: true });
    await cacheSet(cacheKeys.fixture(id), row, CACHE_TTL.fixtureDetail);
    res.json({ ok: true, data: row });
  }));
  v1.get('/fixtures/:id/events', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await fixtureDetail(id);
    const rows = await query(
      `SELECT e.*, tp.name AS team_name, p.name AS player_name, ap.name AS assist_player_name
         FROM fixture_events e
         LEFT JOIN teams tp ON tp.id = e.team_id
         LEFT JOIN players p ON p.id = e.player_id
         LEFT JOIN players ap ON ap.id = e.assist_player_id
        WHERE e.fixture_id = $1 ORDER BY e.elapsed ASC NULLS LAST, e.extra ASC NULLS LAST`,
      [id],
    );
    res.json({ ok: true, data: rows });
  }));
  v1.get('/fixtures/:id/statistics', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await fixtureDetail(id);
    const rows = await query(
      `SELECT s.*, t.name AS team_name FROM fixture_team_statistics s JOIN teams t ON t.id = s.team_id WHERE s.fixture_id = $1`,
      [id],
    );
    res.json({ ok: true, data: rows });
  }));
  v1.get('/fixtures/:id/lineups', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await fixtureDetail(id);
    const lineups = await query(`SELECT l.*, t.name AS team_name FROM lineups l JOIN teams t ON t.id = l.team_id WHERE l.fixture_id = $1`, [id]);
    const players = await query(
      `SELECT lp.*, t.name AS team_name, p.name AS player_name FROM lineup_players lp
        JOIN lineups l ON l.id = lp.lineup_id
        JOIN teams t ON t.id = lp.team_id
        LEFT JOIN players p ON p.id = lp.player_id
       WHERE l.fixture_id = $1 ORDER BY lp.is_starting DESC, lp.number ASC NULLS LAST`,
      [id],
    );
    res.json({ ok: true, data: { lineups, players } });
  }));
  v1.get('/fixtures/:id/players', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await fixtureDetail(id);
    const rows = await query(
      `SELECT ps.*, p.name AS player_name, t.name AS team_name FROM player_match_statistics ps
        JOIN players p ON p.id = ps.player_id
        LEFT JOIN teams t ON t.id = ps.team_id
       WHERE ps.fixture_id = $1 ORDER BY t.name, ps.minutes DESC NULLS LAST`,
      [id],
    );
    res.json({ ok: true, data: rows });
  }));

  // ---- standings ----------------------------------------------------------
  v1.get('/standings', asyncHandler(async (req, res) => {
    const competitionId = Number(req.query.competition_id);
    const seasonId = Number(req.query.season_id);
    if (!competitionId || !seasonId) throw new AppError('competition_id and season_id query parameters required', 400, 'VALIDATION');
    const key = cacheKeys.standings({ competitionId, seasonId });
    const cached = await cacheGet(key);
    if (cached) return res.json({ ok: true, data: cached, cached: true });
    const standings = await query(
      `SELECT s.* FROM standings s
         JOIN competition_seasons cs ON cs.id = s.competition_season_id
         JOIN competitions c ON c.id = cs.competition_id
         JOIN seasons se ON se.id = cs.season_id
        WHERE cs.competition_id = $1 AND cs.season_id = $2
          AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
      [competitionId, seasonId],
    );
    const rows = await query(
      `SELECT sr.*, t.name AS team_name, t.logo_url
         FROM standing_rows sr
         JOIN standings s ON s.id = sr.standings_id
         JOIN competition_seasons cs ON cs.id = s.competition_season_id
         JOIN competitions c ON c.id = cs.competition_id
         JOIN seasons se ON se.id = cs.season_id
         JOIN teams t ON t.id = sr.team_id
        WHERE cs.competition_id = $1 AND cs.season_id = $2
          AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
          AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'
        ORDER BY sr.rank ASC NULLS LAST`,
      [competitionId, seasonId],
    );
    const body = { standings, rows };
    await cacheSet(key, body, CACHE_TTL.standings);
    res.json({ ok: true, data: body });
  }));

  // ---- predictions --------------------------------------------------------
  v1.get('/predictions/features/:fixtureId', asyncHandler(async (req, res) => {
    const fixtureId = Number(req.params.fixtureId);
    const cached = await cacheGet(cacheKeys.prediction(fixtureId));
    if (cached) return res.json({ ok: true, data: cached, cached: true });
    const row = await queryOne(`SELECT * FROM prediction_features WHERE fixture_id = $1`, [fixtureId]);
    if (!row) throw new NotFoundError(`prediction features for fixture ${fixtureId} not built yet`);
    const fixture = await fixtureDetail(fixtureId);
    const body = { fixture, ...row };
    await cacheSet(cacheKeys.prediction(fixtureId), body, CACHE_TTL.predictionFeatures);
    res.json({ ok: true, data: body });
  }));

  // ---- admin --------------------------------------------------------------
  v1.post('/admin/login', adminLoginHandler());
  v1.get('/admin/api-keys', requireAdmin(), asyncHandler(async (_req, res) => {
    const keys = (await listKeys()).map((k) => ({
      id: k.id, client_id: k.client_id, client_name: k.client_name, key_prefix: k.key_prefix,
      scopes: k.scopes, label: k.label, created_at: k.created_at, last_used_at: k.last_used_at,
      expires_at: k.expires_at, revoked_at: k.revoked_at, grace_until: k.grace_until, rotated_from: k.rotated_from,
      managed_role: k.managed_role ?? null,
    })); // never the raw key or its hash
    res.json({ ok: true, data: { keys, clients: await listClients(), scopes: ALL_SCOPES } });
  }));
  v1.post('/admin/clients', requireAdmin(), asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const client = await createClient({
      name: String(body.name ?? '').trim(),
      description: body.description ? String(body.description) : undefined,
      clientType: body.client_type ? String(body.client_type) : undefined,
      rateLimitPerMinute: body.rate_limit_per_minute != null ? Number(body.rate_limit_per_minute) : undefined,
      rateLimitPerDay: body.rate_limit_per_day != null ? Number(body.rate_limit_per_day) : undefined,
    }, 'admin-ui');
    if (!String(body.name ?? '').trim()) throw new AppError('name is required', 400, 'VALIDATION');
    res.status(201).json({ ok: true, data: client });
  }));
  v1.post('/admin/api-keys', requireAdmin(), asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
    const created = await createKey(
      {
        clientName: body.client_name ? String(body.client_name) : undefined,
        clientId: body.client_id != null ? Number(body.client_id) : undefined,
        scopes,
        label: body.label ? String(body.label) : undefined,
        expiresInDays: body.expires_in_days != null ? Number(body.expires_in_days) : null,
      },
      'admin-ui',
    );
    res.status(201).json({ ok: true, data: { id: created.id, client_id: created.clientId, key_prefix: created.keyPrefix, api_key: created.rawKey, warning: 'Store this key now — it will not be shown again.' } });
  }));
  v1.post('/admin/api-keys/:id/rotate', requireAdmin(), asyncHandler(async (req, res) => {
    const rotated = await rotateKey(Number(req.params.id), { graceHours: Number((req.body as { grace_hours?: number })?.grace_hours ?? 24) }, 'admin-ui');
    res.json({ ok: true, data: { id: rotated.id, client_id: rotated.clientId, key_prefix: rotated.keyPrefix, api_key: rotated.rawKey, old_key_valid_until: rotated.oldKeyValidUntil, warning: 'Store this key now — it will not be shown again.' } });
  }));
  v1.post('/admin/api-keys/:id/revoke', requireAdmin(), asyncHandler(async (req, res) => {
    await revokeKey(Number(req.params.id), (req.body as { reason?: string })?.reason ?? 'revoked via admin UI', 'admin-ui');
    res.json({ ok: true });
  }));
  v1.delete('/admin/api-keys/:id', requireAdmin(), asyncHandler(async (req, res) => {
    // PERMANENT physical deletion (not a soft revoke). Idempotent.
    const result = await deleteKeyPermanently(Number(req.params.id), 'admin-ui');
    res.json({ ok: true, data: { deleted: result.deleted, id: result.id, key_prefix: result.keyPrefix } });
  }));
  v1.post('/admin/api-keys/:id/rotate-website', requireAdmin(), asyncHandler(async (req, res) => {
    // Manual, on-demand rotation of the managed Website key (never periodic).
    // Creates + verifies the replacement BEFORE the old key is deleted; the
    // new secret stays server-side (never returned to anyone).
    const keyId = Number(req.params.id);
    const managed = await getManagedWebsiteKeyRecord();
    if (!managed || Number(managed.id) !== keyId) {
      throw new AppError('this key is not the managed website key', 400, 'VALIDATION');
    }
    const rotated = await rotateWebsiteKey('admin-ui');
    res.json({ ok: true, data: { id: rotated.id, key_prefix: rotated.keyPrefix, managed_role: 'website' } });
  }));
  v1.patch('/admin/clients/:id', requireAdmin(), asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { rate_limit_per_minute?: number; rate_limit_per_day?: number; active?: boolean };
    await updateClientLimits(Number(req.params.id), body.rate_limit_per_minute, body.rate_limit_per_day, body.active);
    res.json({ ok: true });
  }));
  v1.get('/admin/usage', requireAdmin(), asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await usageReport() });
  }));
  v1.get('/admin/sync', requireAdmin(), asyncHandler(async (_req, res) => {
    const summary = await syncSummary();
    const failed = await listFailedTasks(50);
    res.json({ ok: true, data: { summary, failedTasks: failed, taskTypes: registeredTaskTypes(), quota: await quotaManager.status() } });
  }));
  v1.post('/admin/sync/retry-failed', requireAdmin(), asyncHandler(async (_req, res) => {
    const retried = await retryFailedTasks();
    res.json({ ok: true, data: { retried } });
  }));

  app.use('/api/v1', v1);

  app.use((_req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'route not found' } }));
  app.use(errorHandler);
  return app;
}
