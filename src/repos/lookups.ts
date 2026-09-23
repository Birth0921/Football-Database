import { query } from '../db/pool.js';
import { nameKey, sha256 } from '../util/hash.js';
import type { CountryRow, CompetitionRow, SeasonRow, CoverageRow } from '../mapping/leagues.js';
import type { TeamRow, VenueRow } from '../mapping/teams.js';
import type { PlayerRowData, CoachRowData } from '../mapping/fixtures.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'repos' });

// ---------- reference data ----------

export async function upsertCountry(row: CountryRow): Promise<number> {
  if (row.providerId) {
    // merge into an existing name-only row first (provider may give both id and bare-name rows)
    const existing = (
      await query<{ id: number }>(
        `SELECT id FROM countries WHERE provider = 'api-football' AND lower(name) = lower($1) LIMIT 1`,
        [row.name],
      )
    ).rows[0];
    if (existing) {
      const { rows } = await query<{ id: number }>(
        `UPDATE countries SET
           provider_id = COALESCE(provider_id, $2),
           code = COALESCE($3, code),
           flag_url = COALESCE($4, flag_url),
           updated_at = now()
         WHERE id = $1 RETURNING id`,
        [existing.id, row.providerId, row.code, row.flagUrl],
      );
      return rows[0].id;
    }
    const { rows } = await query<{ id: number }>(
      `INSERT INTO countries (provider, provider_id, name, code, flag_url)
       VALUES ('api-football', $1, $2, $3, $4)
       ON CONFLICT (provider, coalesce(provider_id, -1)) DO UPDATE
         SET name = EXCLUDED.name, code = EXCLUDED.code, flag_url = EXCLUDED.flag_url, updated_at = now()
       RETURNING id`,
      [row.providerId, row.name, row.code, row.flagUrl],
    );
    return rows[0].id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO countries (provider, name)
     VALUES ('api-football', $1)
     ON CONFLICT (provider, lower(name)) DO UPDATE SET updated_at = now() RETURNING id`,
    [row.name],
  );
  return rows[0].id;
}

export async function upsertVenue(row: VenueRow | null): Promise<number | null> {
  if (!row) return null;
  const countryId = row.country ? await upsertCountry(row.country) : null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO venues (provider, provider_id, name, address, city, country_id, capacity, surface, image_url)
     VALUES ('api-football', $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, coalesce(provider_id, -1)) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, venues.name),
           address = COALESCE(EXCLUDED.address, venues.address),
           city = COALESCE(EXCLUDED.city, venues.city),
           country_id = COALESCE(EXCLUDED.country_id, venues.country_id),
           capacity = COALESCE(EXCLUDED.capacity, venues.capacity),
           surface = COALESCE(EXCLUDED.surface, venues.surface),
           image_url = COALESCE(EXCLUDED.image_url, venues.image_url),
           updated_at = now()
     RETURNING id`,
    [row.providerId, row.name, row.address, row.city, countryId, row.capacity, row.surface, row.imageUrl],
  );
  return rows[0]?.id ?? null;
}

export async function upsertCompetition(row: CompetitionRow): Promise<number> {
  const countryId = row.country ? await upsertCountry(row.country) : null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO competitions (provider, provider_id, name, type, country_id, logo_url)
     VALUES ('api-football', $1, $2, $3, $4, $5)
     ON CONFLICT (provider, provider_id) DO UPDATE
       SET name = EXCLUDED.name, type = EXCLUDED.type,
           country_id = COALESCE(EXCLUDED.country_id, competitions.country_id),
           logo_url = COALESCE(EXCLUDED.logo_url, competitions.logo_url),
           updated_at = now()
     RETURNING id`,
    [row.providerId, row.name, row.type, countryId, row.logoUrl],
  );
  return rows[0].id;
}

export async function upsertSeason(year: number): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO seasons (year) VALUES ($1) ON CONFLICT (year) DO UPDATE SET year = EXCLUDED.year RETURNING id`,
    [year],
  );
  return rows[0].id;
}

export interface CompetitionSeasonRef {
  competitionSeasonId: number;
  competitionId: number;
  seasonYear: number;
}

export async function upsertCompetitionSeason(
  competition: CompetitionRow,
  season: SeasonRow,
  coverage?: CoverageRow,
): Promise<CompetitionSeasonRef> {
  const competitionId = await upsertCompetition(competition);
  const seasonId = await upsertSeason(season.year);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO competition_seasons (competition_id, season_id, provider, provider_id, start_date, end_date, is_current)
     VALUES ($1, $2, 'api-football', $3, $4, $5, $6)
     ON CONFLICT (competition_id, season_id) DO UPDATE
       SET start_date = COALESCE(EXCLUDED.start_date, competition_seasons.start_date),
           end_date = COALESCE(EXCLUDED.end_date, competition_seasons.end_date),
           is_current = EXCLUDED.is_current,
           updated_at = now()
     RETURNING id`,
    [competitionId, seasonId, competition.providerId, season.startDate, season.endDate, season.isCurrent],
  );
  const csId = rows[0].id;
  if (coverage) {
    await query(
      `INSERT INTO competition_season_coverage
         (competition_season_id, events, lineups, fixture_statistics, player_statistics, standings,
          players, top_scorers, top_assists, top_cards, injuries, sidelined, predictions, odds, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (competition_season_id) DO UPDATE
         SET events=EXCLUDED.events, lineups=EXCLUDED.lineups, fixture_statistics=EXCLUDED.fixture_statistics,
             player_statistics=EXCLUDED.player_statistics, standings=EXCLUDED.standings, players=EXCLUDED.players,
             top_scorers=EXCLUDED.top_scorers, top_assists=EXCLUDED.top_assists, top_cards=EXCLUDED.top_cards,
             injuries=EXCLUDED.injuries, sidelined=EXCLUDED.sidelined, predictions=EXCLUDED.predictions,
             odds=EXCLUDED.odds, fetched_at=now(), updated_at=now()`,
      [
        csId, coverage.events, coverage.lineups, coverage.fixtureStatistics, coverage.playerStatistics,
        coverage.standings, coverage.players, coverage.topScorers, coverage.topAssists, coverage.topCards,
        coverage.injuries, coverage.sidelined, coverage.predictions, coverage.odds,
      ],
    );
  }
  return { competitionSeasonId: csId, competitionId, seasonYear: season.year };
}

export async function getCoverage(competitionSeasonId: number): Promise<CoverageRow | null> {
  const { rows } = await query<Record<string, boolean>>(
    `SELECT events, lineups, fixture_statistics, player_statistics, standings, players,
            top_scorers, top_assists, top_cards, injuries, sidelined, predictions, odds
     FROM competition_season_coverage WHERE competition_season_id = $1`,
    [competitionSeasonId],
  );
  const c = rows[0];
  if (!c) return null;
  return {
    events: c.events, lineups: c.lineups, fixtureStatistics: c.fixture_statistics, playerStatistics: c.player_statistics,
    standings: c.standings, players: c.players, topScorers: c.top_scorers, topAssists: c.top_assists,
    topCards: c.top_cards, injuries: c.injuries, sidelined: c.sidelined, predictions: c.predictions, odds: c.odds,
  };
}

export async function upsertCompetitionRound(competitionSeasonId: number, roundName: string): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO competition_rounds (competition_season_id, name)
     VALUES ($1, $2) ON CONFLICT (competition_season_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [competitionSeasonId, roundName],
  );
  return rows[0].id;
}

// ---------- teams / players / coaches / referees ----------

export async function upsertTeam(row: TeamRow): Promise<number> {
  const countryId = row.country ? await upsertCountry(row.country) : null;
  const venueId = await upsertVenue(row.venue);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO teams (provider, provider_id, name, short_name, code, country_id, founded, logo_url, is_national, venue_id, raw)
     VALUES ('api-football', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (provider, provider_id) DO UPDATE
       SET name = EXCLUDED.name,
           short_name = COALESCE(EXCLUDED.short_name, teams.short_name),
           code = COALESCE(EXCLUDED.code, teams.code),
           country_id = COALESCE(EXCLUDED.country_id, teams.country_id),
           founded = COALESCE(EXCLUDED.founded, teams.founded),
           logo_url = COALESCE(EXCLUDED.logo_url, teams.logo_url),
           is_national = EXCLUDED.is_national,
           venue_id = COALESCE(EXCLUDED.venue_id, teams.venue_id),
           updated_at = now()
     RETURNING id`,
    [row.providerId, row.name, row.shortName, row.code, countryId, row.founded, row.logoUrl, row.isNational, venueId, JSON.stringify(row)],
  );
  return rows[0].id;
}

export async function upsertTeamSeason(teamId: number, competitionSeasonId: number): Promise<void> {
  await query(
    `INSERT INTO team_seasons (team_id, competition_season_id) VALUES ($1, $2)
     ON CONFLICT (team_id, competition_season_id) DO NOTHING`,
    [teamId, competitionSeasonId],
  );
}

export async function upsertPlayer(player: PlayerRowData): Promise<number> {
  const nationalityId = player.nationality
    ? await upsertCountry({ providerId: null, name: player.nationality, code: null, flagUrl: null })
    : null;
  const birthCountryId = player.birthCountry
    ? await upsertCountry({ providerId: null, name: player.birthCountry, code: null, flagUrl: null })
    : null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO players (provider, provider_id, firstname, lastname, name, nationality_country_id,
        birth_date, birth_place, birth_country_id, age, height_cm, weight_kg, injured, photo_url)
     VALUES ('api-football', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (provider, provider_id) DO UPDATE
       SET firstname = COALESCE(EXCLUDED.firstname, players.firstname),
           lastname = COALESCE(EXCLUDED.lastname, players.lastname),
           name = EXCLUDED.name,
           nationality_country_id = COALESCE(EXCLUDED.nationality_country_id, players.nationality_country_id),
           birth_date = COALESCE(EXCLUDED.birth_date, players.birth_date),
           birth_place = COALESCE(EXCLUDED.birth_place, players.birth_place),
           birth_country_id = COALESCE(EXCLUDED.birth_country_id, players.birth_country_id),
           age = COALESCE(EXCLUDED.age, players.age),
           height_cm = COALESCE(EXCLUDED.height_cm, players.height_cm),
           weight_kg = COALESCE(EXCLUDED.weight_kg, players.weight_kg),
           injured = COALESCE(EXCLUDED.injured, players.injured),
           photo_url = COALESCE(EXCLUDED.photo_url, players.photo_url),
           updated_at = now()
     RETURNING id`,
    [
      player.providerId, player.firstname, player.lastname, player.name, nationalityId,
      player.birthDate, player.birthPlace, birthCountryId, player.age, player.height, player.weight,
      player.injured, player.photo,
    ],
  );
  return rows[0].id;
}

export async function upsertPlayerTeamHistory(playerId: number, teamId: number, competitionSeasonId: number | null, teamType?: string): Promise<void> {
  await query(
    `INSERT INTO player_team_history (player_id, team_id, competition_season_id, team_type)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [playerId, teamId, competitionSeasonId, teamType ?? 'club'],
  );
}

export async function upsertCoach(row: CoachRowData): Promise<number> {
  const countryId = row.nationality
    ? await upsertCountry({ providerId: null, name: row.nationality, code: null, flagUrl: null })
    : null;
  const teamId = row.teamProviderId
    ? (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [row.teamProviderId])).rows[0]?.id ?? null
    : null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO coaches (provider, provider_id, firstname, lastname, name, age, birth_date, birth_place, country_id, photo_url, team_id, career)
     VALUES ('api-football', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (provider, coalesce(provider_id, -1)) DO UPDATE
       SET name = EXCLUDED.name, firstname = COALESCE(EXCLUDED.firstname, coaches.firstname),
           lastname = COALESCE(EXCLUDED.lastname, coaches.lastname), age = COALESCE(EXCLUDED.age, coaches.age),
           birth_date = COALESCE(EXCLUDED.birth_date, coaches.birth_date), photo_url = COALESCE(EXCLUDED.photo_url, coaches.photo_url),
           team_id = COALESCE(EXCLUDED.team_id, coaches.team_id), career = EXCLUDED.career, updated_at = now()
     RETURNING id`,
    [row.providerId, row.firstname, row.lastname, row.name, row.age, row.birthDate, row.birthPlace, countryId, row.photo, teamId, JSON.stringify(row.career)],
  );
  // coach history rows
  for (const c of row.career) {
    if (!c.teamProviderId) continue;
    const histTeamId = (
      await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [c.teamProviderId])
    ).rows[0]?.id;
    if (!histTeamId) continue;
    await query(
      `INSERT INTO team_coach_history (coach_id, team_id, start_date, end_date)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [rows[0].id, histTeamId, c.start, c.end && c.end !== '0000-00-00' ? c.end : null],
    );
  }
  return rows[0].id;
}

export async function upsertReferee(name: string, country: string | null): Promise<number | null> {
  if (!name || !name.trim()) return null;
  const key = nameKey(name);
  const countryId = country ? await upsertCountry({ providerId: null, name: country, code: null, flagUrl: null }) : null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO referees (provider, name, name_key, nationality_country_id)
     VALUES ('api-football', $1, $2, $3)
     ON CONFLICT (provider, name_key) DO UPDATE
       SET name = EXCLUDED.name,
           nationality_country_id = COALESCE(EXCLUDED.nationality_country_id, referees.nationality_country_id),
           updated_at = now()
     RETURNING id`,
    [name.trim(), key, countryId],
  );
  return rows[0].id;
}

export async function resolveCompetitionSeason(providerLeagueId: number, seasonYear: number): Promise<CompetitionSeasonRef | null> {
  const { rows } = await query<CompetitionSeasonRef>(
    `SELECT cs.id as "competitionSeasonId", cs.competition_id as "competitionId", s.year as "seasonYear"
     FROM competition_seasons cs
     JOIN competitions c ON c.id = cs.competition_id
     JOIN seasons s ON s.id = cs.season_id
     WHERE cs.provider = 'api-football' AND cs.provider_id = $1 AND s.year = $2
     LIMIT 1`,
    [providerLeagueId, seasonYear],
  );
  return rows[0] ?? null;
}

export { sha256, log };
