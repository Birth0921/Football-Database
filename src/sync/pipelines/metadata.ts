/**
 * Metadata pipeline: countries, competitions, seasons, competition_seasons,
 * coverage discovery, teams, squads, referees.
 */
import { getProvider } from '../../provider/client.js';
import { query, queryOne } from '../../lib/db.js';
import {
  b, linkPlayerTeam, n, s, upsertCompetition, upsertCompetitionSeason, upsertCountry,
  upsertPlayer, upsertReferee, upsertSeason, upsertTeam,
} from '../../provider/mapper.js';
import type { AfLeague, AfTeam, AfSquadEntry, AfPlayerInfo } from '../../provider/types.js';
import { enqueueTask, upsertJob } from '../tasks.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

export async function importCompetitions(): Promise<{ competitions: number; seasons: number }> {
  const provider = await getProvider();
  type LeagueEntry = { league?: AfLeague } & Partial<AfLeague> & { country?: { name?: string; code?: string; flag?: string }; seasons?: { year: number; start?: string; end?: string; current?: boolean }[] };
  const res = await provider.get<LeagueEntry>('/leagues', {});
  let comps = 0;
  const seasonYears = new Set<number>();

  for (const entry of res.data.response) {
    const league = (entry.league ?? entry) as AfLeague;
    const countryName = entry.country?.name ?? s(league.country) ?? null;
    const countryId = await upsertCountry({
      name: countryName,
      code: entry.country?.code ?? null,
      flag: entry.country?.flag ?? null,
    });
    const competitionId = await upsertCompetition(
      { ...league, type: league.type ?? 'League' },
      countryId,
    );
    comps += 1;
    for (const sy of entry.seasons ?? []) {
      if (sy.year == null) continue;
      seasonYears.add(Number(sy.year));
      const seasonId = await upsertSeason(Number(sy.year), { start: sy.start ?? null, end: sy.end ?? null, current: sy.current ?? false });
      await upsertCompetitionSeason(competitionId, seasonId, sy.current ?? false);
    }
  }

  // Ensure the standard window exists even if provider omits seasons for some leagues
  const nowYear = new Date().getUTCFullYear();
  // current season is the one starting in August of the current year (or previous if before August)
  const currentSeasonStartYear = new Date().getUTCMonth() >= 7 ? nowYear : nowYear - 1;
  for (let y = currentSeasonStartYear - config.historicalSeasonsBack; y <= currentSeasonStartYear; y++) {
    seasonYears.add(y);
    await upsertSeason(y, { current: y === currentSeasonStartYear });
  }

  // pair every in-scope competition with the window seasons
  const competitionRows = await query<{ id: number }>(`SELECT id FROM competitions`);
  for (const c of competitionRows) {
    for (const y of seasonYears) {
      const inWindow = y > currentSeasonStartYear - config.historicalSeasonsBack - 1 && y <= currentSeasonStartYear;
      const season = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = $1`, [y]);
      if (!season) continue;
      await query(
        `INSERT INTO competition_seasons (competition_id, season_id, is_current, import_scope)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (competition_id, season_id) DO UPDATE SET is_current = EXCLUDED.is_current, updated_at = now()`,
        [c.id, season.id, y === currentSeasonStartYear, inWindow ? 'in_scope' : 'out_of_scope'],
      );
    }
  }

  logger.info({ comps, seasons: seasonYears.size }, 'competitions/seasons imported');
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

    // squad
    const squadRes = await provider.get<AfSquadEntry>('/players/squads', { team: teamDto.id });
    for (const sq of squadRes.data.response) {
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

/** Enqueue coverage + teams for every in-scope competition/season. */
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
      taskKey: `coverage:${r.competition_id}:${r.season_id}`,
      taskType: 'coverage:discover',
      params: { competitionId: r.competition_id, seasonId: r.season_id },
      priority: 40,
      jobId,
    });
    await enqueueTask({
      taskKey: `teams:${r.competition_id}:${r.season_id}`,
      taskType: 'teams:import',
      params: { competitionId: r.competition_id, seasonId: r.season_id },
      priority: 45,
      jobId,
    });
  }
  return { tasks: rows.length * 2 };
}

void b;
void n;
