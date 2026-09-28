/**
 * Metadata pipeline: countries, competitions, seasons, competition_seasons,
 * coverage discovery, teams, squads, referees.
 */
import { getProvider } from '../../provider/client.js';
import { query, queryOne } from '../../lib/db.js';
import {
  b, linkPlayerTeam, n, s, upsertPlayer, upsertReferee, upsertSeason, upsertTeam,
} from '../../provider/mapper.js';
import type { AfLeague, AfTeam, AfSquadEntry, AfPlayerInfo } from '../../provider/types.js';
import { enqueueTask, upsertJob } from '../tasks.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { cacheGet, cacheSet } from '../../lib/cache.js';

/** Run `fn` over `items` with a FIXED maximum of concurrent tasks (never unbounded). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Import every league/season returned by API-Football, plus the configured
 * historical window, then pair competitions with seasons.
 *
 * Optimized to O(few) database round trips: distinct countries, seasons and
 * competitions are extracted in memory first, then written with batched
 * multi-row upserts; season IDs are cached in a map instead of being
 * re-queried per pair; the competition×season pairing is a single
 * INSERT…SELECT per chunk of years instead of two queries per pair. Chunked
 * writes run with bounded concurrency (2) so Neon is never overwhelmed.
 * Idempotent: re-running produces identical rows (ON CONFLICT upserts).
 */
export async function importCompetitions(): Promise<{ competitions: number; seasons: number }> {
  const t0 = Date.now();
  const provider = await getProvider();
  type LeagueEntry = { league?: AfLeague } & Partial<AfLeague> & { country?: { name?: string; code?: string; flag?: string }; seasons?: { year: number; start?: string; end?: string; current?: boolean }[] };
  const res = await provider.get<LeagueEntry>('/leagues', {});
  const fetchMs = Date.now() - t0;
  const comps = res.data.response.length;
  const seasonYears = new Set<number>();

  // ---- in-memory extraction (no DB round trips) -----------------------------
  // countries: lower(name) → {name, code, flag}; first league wins for shared names
  const countries = new Map<string, { name: string; code: string | null; flag: string | null }>();
  // seasons: year → merged {start, end, current} (OR-merge of provider flags)
  const seasonsByYear = new Map<number, { start: string | null; end: string | null; current: boolean }>();
  const noteSeason = (year: number, start?: string | null, end?: string | null, current?: boolean) => {
    const existing = seasonsByYear.get(year);
    if (!existing) {
      seasonsByYear.set(year, { start: s(start) ?? null, end: s(end) ?? null, current: current ?? false });
    } else {
      if (!existing.start && start) existing.start = s(start);
      if (!existing.end && end) existing.end = s(end);
      if (current) existing.current = true;
    }
  };

  const tExtract0 = Date.now();
  const leagueRows: { dto: AfLeague & { type?: string | null }; raw: unknown; countryName: string | null }[] = [];
  for (const entry of res.data.response) {
    const league = (entry.league ?? entry) as AfLeague;
    const dto = { ...league, type: league.type ?? 'League' };
    const countryName = entry.country?.name ?? s(league.country) ?? null;
    leagueRows.push({ dto, raw: dto, countryName });
    if (countryName) {
      const key = countryName.toLowerCase();
      if (!countries.has(key)) {
        countries.set(key, {
          name: countryName,
          code: s(entry.country?.code ?? null),
          flag: s(entry.country?.flag ?? null),
        });
      }
    }
    for (const sy of entry.seasons ?? []) {
      if (sy.year == null) continue;
      seasonYears.add(Number(sy.year));
      noteSeason(Number(sy.year), sy.start ?? null, sy.end ?? null, sy.current ?? false);
    }
  }

  // standard window exists even if the provider omits seasons for some leagues
  const nowYear = new Date().getUTCFullYear();
  // current season is the one starting in August of the current year (or previous if before August)
  const currentSeasonStartYear = new Date().getUTCMonth() >= 7 ? nowYear : nowYear - 1;
  for (let y = currentSeasonStartYear - config.historicalSeasonsBack; y <= currentSeasonStartYear; y++) {
    seasonYears.add(y);
    noteSeason(y, undefined, undefined, y === currentSeasonStartYear);
  }
  const extractMs = Date.now() - tExtract0;

  // ---- phase 1: batch upsert distinct seasons, then cache id per year -------
  const tSeasons0 = Date.now();
  const yearList = [...seasonsByYear.keys()].sort((a, z) => a - z);
  await mapWithConcurrency(chunk(yearList, 400), 2, async (years) => {
    await query(
      `INSERT INTO seasons (year, display_name, start_date, end_date, is_current, provider, provider_id, raw)
       SELECT y, y || '/' || right((y + 1)::text, 2), st, en, cur, 'api-football', y::text, '{}'::jsonb
         FROM unnest($1::int[], $2::date[], $3::date[], $4::bool[]) AS t(y, st, en, cur)
       ON CONFLICT (provider, provider_id) DO UPDATE SET
         year = EXCLUDED.year, display_name = EXCLUDED.display_name,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         is_current = EXCLUDED.is_current, updated_at = now()`,
      [
        years,
        years.map((y) => seasonsByYear.get(y)!.start),
        years.map((y) => seasonsByYear.get(y)!.end),
        years.map((y) => seasonsByYear.get(y)!.current),
      ],
    );
  });
  // cache season IDs (one query) — previously re-queried per competition×year
  const seasonIdRows = await query<{ id: number; year: number }>(
    `SELECT id, year FROM seasons WHERE year = ANY($1::int[])`, [yearList],
  );
  const seasonIdByYear = new Map<number, number>(seasonIdRows.map((r) => [r.year, r.id]));
  const seasonsMs = Date.now() - tSeasons0;

  // ---- phase 2: batch upsert distinct countries (insert-if-absent by name) --
  const tCountries0 = Date.now();
  const countryList = [...countries.values()];
  if (countryList.length > 0) {
    await query(
      `INSERT INTO countries (name, code, flag_url, provider, raw)
       SELECT nm, cd, fl, 'api-football', '{}'::jsonb
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(nm, cd, fl)
        WHERE NOT EXISTS (SELECT 1 FROM countries c WHERE lower(c.name) = lower(t.nm))`,
      [countryList.map((c) => c.name), countryList.map((c) => c.code), countryList.map((c) => c.flag)],
    );
  }
  // cache country IDs (one query)
  const countryIdRows = await query<{ id: number; lname: string }>(
    `SELECT id, lower(name) AS lname FROM countries WHERE lower(name) = ANY($1::text[])`,
    [countryList.map((c) => c.name.toLowerCase())],
  );
  const countryIdByName = new Map<string, number>(countryIdRows.map((r) => [r.lname, r.id]));
  const countriesMs = Date.now() - tCountries0;

  // ---- phase 3: batch upsert competitions (jsonb payloads, bounded concurrency)
  const tComps0 = Date.now();
  const competitionPayloads = leagueRows.map(({ dto, raw, countryName }) => ({
    name: s(dto.name) ?? 'Unknown',
    code: s(dto.code),
    type: s(dto.type),
    country_id: countryName ? (countryIdByName.get(countryName.toLowerCase()) ?? null) : null,
    logo: s(dto.logo),
    flag: s(dto.flag),
    national: b(dto.is_national),
    pid: String(dto.id),
    raw,
  }));
  const compIdRows = await mapWithConcurrency(chunk(competitionPayloads, 250), 2, async (rows) =>
    query<{ id: number; provider_id: string }>(
      `INSERT INTO competitions (name, code, type, country_id, logo_url, flag_url, is_national, provider, provider_id, raw)
       SELECT r.name, r.code, r.type, r.country_id, r.logo, r.flag, r.national, 'api-football', r.pid, r.raw
         FROM jsonb_to_recordset($1::jsonb)
         AS r(name text, code text, type text, country_id bigint, logo text, flag text, national boolean, pid text, raw jsonb)
       ON CONFLICT (provider, provider_id) DO UPDATE SET
         name = EXCLUDED.name, code = EXCLUDED.code, type = EXCLUDED.type,
         country_id = EXCLUDED.country_id, logo_url = EXCLUDED.logo_url, flag_url = EXCLUDED.flag_url,
         is_national = EXCLUDED.is_national, raw = EXCLUDED.raw, updated_at = now()
       RETURNING id, provider_id`,
      [JSON.stringify(rows)],
    ),
  );
  const compsMs = Date.now() - tComps0;

  // ---- phase 4: pair ALL competitions × known season years ------------------
  // One INSERT…SELECT per chunk of years (cross join in SQL, not per-pair
  // round trips). is_current is (year = current window start); import_scope is
  // preserved for existing rows (not updated on conflict) — exactly the
  // previous semantics.
  const tPair0 = Date.now();
  const scopeFloor = currentSeasonStartYear - config.historicalSeasonsBack - 1;
  let pairedRows = 0;
  const pairingResults = await mapWithConcurrency(chunk(yearList, 12), 2, async (years) =>
    query<{ c: number }>(
      `WITH ins AS (
         INSERT INTO competition_seasons (competition_id, season_id, is_current, import_scope)
         SELECT c.id, s.id, (s.year = $1),
                CASE WHEN s.year > $2 AND s.year <= $1 THEN 'in_scope' ELSE 'out_of_scope' END
           FROM competitions c CROSS JOIN seasons s
          WHERE s.year = ANY($3::int[])
         ON CONFLICT (competition_id, season_id) DO UPDATE SET is_current = EXCLUDED.is_current, updated_at = now()
         RETURNING 1)
       SELECT count(*)::int AS c FROM ins`,
      [currentSeasonStartYear, scopeFloor, years],
    ),
  );
  pairedRows = pairingResults.reduce((sum, r) => sum + (r[0]?.c ?? 0), 0);
  const pairMs = Date.now() - tPair0;

  logger.info({
    comps,
    seasons: seasonYears.size,
    countries: countryList.length,
    newPairRows: pairedRows,
    timingMs: { fetch: fetchMs, extract: extractMs, seasons: seasonsMs, countries: countriesMs, competitions: compsMs, pairing: pairMs, total: Date.now() - t0 },
  }, 'competitions/seasons imported (batched)');
  return { competitions: comps, seasons: seasonYears.size };
}

export interface CoverageFlags {
  events: boolean;
  lineups: boolean;
  fixture_statistics: boolean;
  player_statistics: boolean;
  standings: boolean;
  players: boolean;
  top_scorers: boolean;
  top_assists: boolean;
  top_cards: boolean;
  injuries: boolean;
  sidelined: boolean;
  predictions: boolean;
  odds: boolean;
  referees: boolean;
}

/**
 * Probe supported endpoints for a competition/season (1 cheap request each) and
 * persist the flags so later syncs never request unsupported endpoints.
 */
export async function discoverCoverage(competitionId: number, seasonId: number): Promise<CoverageFlags> {
  const provider = await getProvider();
  const ids = await queryOne<{ provider_id: string; season_year: number }>(
    `SELECT c.provider_id, se.year AS season_year
       FROM competitions c, seasons se
      WHERE c.id = $1 AND se.id = $2`,
    [competitionId, seasonId],
  );
  if (!ids) throw new Error(`competition/season not found: ${competitionId}/${seasonId}`);

  const pLeague = Number(ids.provider_id);
  const pSeason = ids.season_year;

  const probe = async (endpoint: string, params: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await provider.get(endpoint, params);
      return res.data.results > 0;
    } catch {
      return false;
    }
  };

  const [standings, players, injuries, odds, referees] = await Promise.all([
    probe('/standings', { league: pLeague, season: pSeason }),
    probe('/players', { league: pLeague, season: pSeason }),
    probe('/injuries', { league: pLeague, season: pSeason }),
    probe('/odds', { league: pLeague, season: pSeason }),
    probe('/referees', { league: pLeague, season: pSeason }),
  ]);

  const flags: CoverageFlags = {
    // fixtures always exist if the competition exists; detail endpoints are probed later on first fixtures
    events: true,
    lineups: true,
    fixture_statistics: true,
    player_statistics: players,
    standings,
    players,
    top_scorers: players,
    top_assists: players,
    top_cards: players,
    injuries,
    sidelined: injuries,
    predictions: false,
    odds,
    referees,
  };

  await query(
    `INSERT INTO competition_season_coverage
       (competition_season_id, fixtures_known, events, lineups, fixture_statistics, player_statistics,
        standings, players, top_scorers, top_assists, top_cards, injuries, sidelined, predictions, odds, referees, detected_at)
     SELECT cs.id, TRUE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now()
       FROM competition_seasons cs WHERE cs.competition_id = $1 AND cs.season_id = $16
     ON CONFLICT (competition_season_id) DO UPDATE SET
       events = EXCLUDED.events, lineups = EXCLUDED.lineups, fixture_statistics = EXCLUDED.fixture_statistics,
       player_statistics = EXCLUDED.player_statistics, standings = EXCLUDED.standings, players = EXCLUDED.players,
       top_scorers = EXCLUDED.top_scorers, top_assists = EXCLUDED.top_assists, top_cards = EXCLUDED.top_cards,
       injuries = EXCLUDED.injuries, sidelined = EXCLUDED.sidelined, predictions = EXCLUDED.predictions,
       odds = EXCLUDED.odds, referees = EXCLUDED.referees, detected_at = now(), updated_at = now()`,
    [
      competitionId,
      flags.events, flags.lineups, flags.fixture_statistics, flags.player_statistics,
      flags.standings, flags.players, flags.top_scorers, flags.top_assists, flags.top_cards,
      flags.injuries, flags.sidelined, flags.predictions, flags.odds, flags.referees,
      seasonId,
    ],
  );
  return flags;
}

export async function getCoverage(competitionId: number, seasonId: number): Promise<CoverageFlags | null> {
  const row = await queryOne<CoverageFlags>(
    `SELECT cov.* FROM competition_season_coverage cov
       JOIN competition_seasons cs ON cs.id = cov.competition_season_id
      WHERE cs.competition_id = $1 AND cs.season_id = $2`,
    [competitionId, seasonId],
  );
  return row ?? null;
}

/** Import teams + squads + referee list for a competition/season. */
export async function importTeamsAndSquads(competitionId: number, seasonId: number): Promise<{ teams: number; players: number; referees: number }> {
  const provider = await getProvider();
  const ids = await queryOne<{ provider_id: string; season_year: number }>(
    `SELECT c.provider_id, se.year AS season_year FROM competitions c, seasons se WHERE c.id = $1 AND se.id = $2`,
    [competitionId, seasonId],
  );
  if (!ids) throw new Error(`competition/season not found: ${competitionId}/${seasonId}`);
  const pLeague = Number(ids.provider_id);
  const pSeason = ids.season_year;

  const teamsRes = await provider.get<AfTeam & { venue?: unknown; team?: AfTeam } & { id: number; name: string }>('/teams', { league: pLeague, season: pSeason });
  let teams = 0;
  let players = 0;
  for (const entry of teamsRes.data.response) {
    const teamDto = (entry as { team?: AfTeam }).team ?? (entry as unknown as AfTeam);
    const countryRow = await queryOne<{ id: number }>(
      `SELECT id FROM countries WHERE lower(name) = lower($1) LIMIT 1`,
      [s((teamDto as AfTeam).country) ?? ''],
    );
    const teamId = await upsertTeam({
      id: teamDto.id ?? null,
      name: teamDto.name,
      code: teamDto.code,
      country: (teamDto as AfTeam).country,
      founded: teamDto.founded,
      national: teamDto.national,
      logo: teamDto.logo,
      venue: (entry as { venue?: { id?: number | null; name?: string | null; city?: string | null; capacity?: number | null; surface?: string | null; image?: string | null } }).venue ?? null,
      countryId: countryRow?.id ?? null,
      raw: entry,
    });
    if (!teamId) continue;
    teams += 1;
    await query(
      `INSERT INTO team_seasons (team_id, competition_id, season_id)
       VALUES ($1, $2, $3) ON CONFLICT (team_id, competition_id, season_id) DO NOTHING`,
      [teamId, competitionId, seasonId],
    );

    // squad — /players/squads has no season parameter (it always returns the
    // CURRENT squad), so the response is cached per team for 12h in live mode:
    // a team appearing in N seasons costs ONE request per window, not N.
    let squadEntries: AfSquadEntry[] | null = null;
    const cacheKey = `sync:squad:${teamDto.id}`;
    if (config.providerMode === 'live') {
      squadEntries = await cacheGet<AfSquadEntry[]>(cacheKey);
    }
    if (!squadEntries) {
      const squadRes = await provider.get<AfSquadEntry>('/players/squads', { team: teamDto.id });
      squadEntries = squadRes.data.response as AfSquadEntry[];
      if (config.providerMode === 'live') {
        await cacheSet(cacheKey, squadEntries, 12 * 3600);
      }
    }
    for (const sq of squadEntries) {
      for (const p of sq.players ?? []) {
        const playerPayload: AfPlayerInfo & { number?: number | null; position?: string | null } = {
          id: p.id ?? null,
          name: p.name ?? null,
          age: p.age ?? null,
          photo: p.photo ?? null,
          number: p.number ?? null,
          position: p.position ?? null,
        };
        const playerId = await upsertPlayer(playerPayload, teamId);
        if (!playerId) continue;
        players += 1;
        const season = await queryOne<{ year: number }>(`SELECT year FROM seasons WHERE id = $1`, [seasonId]);
        await linkPlayerTeam(playerId, teamId, seasonId, {
          number: p.number ?? null,
          position: p.position ?? null,
          startDate: season ? `${season.year}-07-01` : null,
        });
      }
    }
  }

  let referees = 0;
  const cov = await getCoverage(competitionId, seasonId);
  if (cov?.referees !== false) {
    const refRes = await provider.get<{ id: number; name?: string; firstname?: string; lastname?: string; country?: string }>('/referees', { league: pLeague, season: pSeason });
    for (const r of refRes.data.response) {
      const id = await upsertReferee({ id: r.id ?? null, name: r.name ?? null, firstname: r.firstname ?? null, lastname: r.lastname ?? null, country: r.country ?? null });
      if (id) referees += 1;
    }
  }

  // team coach history entries (from raw team payloads where present)
  for (const entry of teamsRes.data.response) {
    const coach = (entry as { coach?: { id?: number | null; name?: string | null; nationality?: string | null } }).coach;
    const teamDto = (entry as { team?: AfTeam }).team ?? (entry as unknown as AfTeam);
    if (coach?.name && teamDto.id != null) {
      const team = await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(teamDto.id)]);
      if (team) {
        await query(
          `INSERT INTO team_coach_history (team_id, coach_name, nationality, start_date, provider_id, raw)
           VALUES ($1, $2, $3, NULL, $4, $5) ON CONFLICT DO NOTHING`,
          [team.id, coach.name, s(coach.nationality), coach.id != null ? String(coach.id) : null, JSON.stringify(coach)],
        );
      }
    }
  }

  return { teams, players, referees };
}

export async function importSeasonsCli(): Promise<{ seasons: number }> {
  const provider = await getProvider();
  const res = await provider.get<{ year: number; start?: string; end?: string; current?: boolean }>('/leagues/seasons', {});
  const years = new Set<number>();
  for (const sy of res.data.response) {
    if (sy.year == null) continue;
    years.add(Number(sy.year));
    await upsertSeason(Number(sy.year), { start: sy.start ?? null, end: sy.end ?? null, current: sy.current ?? false });
  }
  return { seasons: years.size };
}

/** Enqueue fixture imports for every in-scope competition/season (current
 *  seasons first). Coverage/teams/standings follow-ups are chained by the
 *  fixtures:import handler only for pairs that actually have fixtures. */
export async function enqueueSeasonWindowTasks(): Promise<{ tasks: number }> {
  const rows = await query<{ competition_id: number; season_id: number }>(
    `SELECT cs.competition_id, cs.season_id
       FROM competition_seasons cs
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.import_scope = 'in_scope'
      ORDER BY se.year DESC`,
  );
  const jobId = await upsertJob(`season-window:${new Date().toISOString().slice(0, 10)}`, 'metadata', { count: rows.length }, 20);
  for (const r of rows) {
    await enqueueTask({
      taskKey: `fixtures:import:${r.competition_id}:${r.season_id}`,
      taskType: 'fixtures:import',
      params: { competitionId: r.competition_id, seasonId: r.season_id },
      priority: 55,
      jobId,
    });
  }
  return { tasks: rows.length };
}

void b;
void n;
