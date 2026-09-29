/**
 * Provider → database normalization.
 * API-Football payload shapes mapped into warehouse rows. Unknown/unmodeled
 * fields always land in the row's `raw` JSONB so nothing is discarded.
 */
import type {
  AfEvent, AfInjury, AfLeague, AfLineup, AfLineupPlayer, AfPlayerInfo, AfPlayerStatEntry,
  AfStandingRow, AfStandingsEntry, AfTeamStatEntry, AfTransfer, AfFixture,
} from './types.js';
import { execute, query, queryOne, upsertSql } from '../lib/db.js';
import { COMPLETED_STATUSES, LIVE_STATUSES } from '../types.js';

export function s(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' || t.toLowerCase() === 'null' ? null : t;
}

export function n(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).replace('%', '').trim();
  if (t === '' || t.toLowerCase() === 'null') return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

export function num3(v: unknown): number | null {
  const x = n(v);
  return x === null ? null : Math.round(x * 1000) / 1000;
}

export function b(v: unknown): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes'].includes(String(v).toLowerCase());
}

export function dateOnly(v: unknown): string | null {
  const t = s(v);
  return t ? t.slice(0, 10) : null;
}

export function timestamptz(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Reference entities
// ---------------------------------------------------------------------------
export async function upsertCountry(input: { name?: string | null; code?: string | null; flag?: string | null; providerId?: string | null; raw?: unknown }): Promise<number | null> {
  const name = s(input.name);
  if (!name && !input.providerId) return null;
  const row = await queryOne<{ id: number }>(
    `${upsertSql('countries', ['name', 'code', 'flag_url', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
    [name ?? 'Unknown', s(input.code), s(input.flag), input.providerId != null ? String(input.providerId) : null, JSON.stringify(input.raw ?? {})],
  );
  return row?.id ?? null;
}

export async function upsertVenue(input: { id?: number | null; name?: string | null; city?: string | null; address?: string | null; capacity?: number | null; surface?: string | null; image?: string | null; countryId?: number | null }): Promise<number | null> {
  if (input.id == null && !input.name) return null;
  const row = await queryOne<{ id: number }>(
    `${upsertSql('venues', ['name', 'city', 'address', 'capacity', 'surface', 'image_url', 'country_id', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
    [s(input.name), s(input.city), s(input.address), n(input.capacity), s(input.surface), s(input.image), input.countryId ?? null, input.id != null ? String(input.id) : null, JSON.stringify(input)],
  );
  return row?.id ?? null;
}

export async function upsertCompetition(league: AfLeague | { id: number; name: string; type?: string | null; code?: string | null; is_national?: boolean | null; logo?: string | null; flag?: string | null; country?: string | null }, countryId: number | null): Promise<number> {
  const l = league as AfLeague & { type?: string; code?: string; is_national?: boolean };
  const row = await queryOne<{ id: number }>(
    `${upsertSql('competitions', ['name', 'code', 'type', 'country_id', 'logo_url', 'flag_url', 'is_national', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
    [s(l.name) ?? 'Unknown', s(l.code), s(l.type), countryId, s(l.logo), s(l.flag), b(l.is_national), String(l.id), JSON.stringify(l)],
  );
  return row!.id;
}

export async function upsertSeason(year: number, opts: { start?: string | null; end?: string | null; current?: boolean } = {}): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `${upsertSql('seasons', ['year', 'display_name', 'start_date', 'end_date', 'is_current', 'provider_id'], ['provider', 'provider_id'], ['year', 'display_name', 'start_date', 'end_date', 'is_current'])} RETURNING id`,
    [year, `${year}/${String(year + 1).slice(2)}`, dateOnly(opts.start), dateOnly(opts.end), opts.current ?? false, String(year)],
  );
  return row!.id;
}

export async function upsertCompetitionSeason(competitionId: number, seasonId: number, isCurrent: boolean): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `${upsertSql('competition_seasons', ['competition_id', 'season_id', 'is_current'], ['competition_id', 'season_id'])} RETURNING id`,
    [competitionId, seasonId, isCurrent],
  );
  return row!.id;
}

export async function upsertTeam(input: {
  id: number | null; name?: string | null; code?: string | null; country?: string | null;
  founded?: number | null; national?: boolean | null; logo?: string | null;
  venue?: { id?: number | null; name?: string | null; city?: string | null; address?: string | null; capacity?: number | null; surface?: string | null; image?: string | null } | null;
  countryId?: number | null; raw?: unknown;
}): Promise<number | null> {
  if (input.id == null) return null;
  const venueId = await upsertVenue({ ...(input.venue ?? {}), countryId: input.countryId ?? null });
  const row = await queryOne<{ id: number }>(
    `${upsertSql('teams', ['name', 'short_name', 'code', 'country_id', 'founded', 'national_flag', 'logo_url', 'venue_id', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
    [
      s(input.name) ?? `Team ${input.id}`,
      null,
      s(input.code),
      input.countryId ?? null,
      n(input.founded),
      b(input.national),
      s(input.logo),
      venueId,
      String(input.id),
      JSON.stringify(input.raw ?? input),
    ],
  );
  return row!.id;
}

export async function upsertPlayer(p: AfPlayerInfo & { number?: number | null; position?: string | null }, teamId: number | null): Promise<number | null> {
  if (p.id == null) return null;
  const row = await queryOne<{ id: number }>(
    `${upsertSql('players', ['name', 'first_name', 'last_name', 'date_of_birth', 'age', 'nationality', 'height_cm', 'weight_kg', 'position', 'photo_url', 'current_team_id', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
    [
      s(p.name) ?? `Player ${p.id}`,
      s(p.firstname),
      s(p.lastname),
      dateOnly(p.birth?.date),
      n(p.age),
      s(p.nationality),
      n(p.height),
      n(p.weight),
      s(p.position),
      s(p.photo),
      teamId,
      String(p.id),
      JSON.stringify(p),
    ],
  );
  return row!.id;
}

export async function linkPlayerTeam(playerId: number, teamId: number, seasonId: number | null, info: { number?: number | null; position?: string | null; startDate?: string | null } = {}): Promise<void> {
  await query(
    `INSERT INTO player_team_history (player_id, team_id, season_id, number, position, start_date, provider_history_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (player_id, team_id, start_date, provider_history_id) DO UPDATE
       SET number = EXCLUDED.number, position = EXCLUDED.position, season_id = COALESCE(EXCLUDED.season_id, player_team_history.season_id), updated_at = now()`,
    [playerId, teamId, seasonId, n(info.number), s(info.position), info.startDate ?? null, 'primary'],
  );
}

export async function upsertReferee(input: { id: number | null; name?: string | null; firstname?: string | null; lastname?: string | null; country?: string | null }): Promise<number | null> {
  if (input.id == null && !input.name) return null;
  const row = await queryOne<{ id: number }>(
    `${upsertSql('referees', ['name', 'first_name', 'last_name', 'nationality', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
    [s(input.name) ?? 'Unknown referee', s(input.firstname), s(input.lastname), s(input.country), input.id != null ? String(input.id) : null, JSON.stringify(input)],
  );
  return row!.id;
}

// ---------------------------------------------------------------------------
// Fixtures & details
// ---------------------------------------------------------------------------
export interface FixtureIds {
  fixtureId: number;
  changed: boolean;
  completed: boolean;
  justCompleted: boolean;
}

export async function upsertFixture(f: AfFixture, ids: {
  competitionId: number | null;
  seasonId: number | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  venueId: number | null;
  refereeId: number | null;
}): Promise<FixtureIds | null> {
  if (f.id == null) return null;
  const statusShort = s(f.status?.short)?.toUpperCase() ?? 'TBD';
  const kickoff = timestamptz(f.date);
  const payload = {
    statusShort,
    statusLong: s(f.status?.long),
    elapsed: n(f.status?.elapsed),
    homeScore: n(f.goals?.home),
    awayScore: n(f.goals?.away),
    htHome: n(f.score?.halftime?.home),
    htAway: n(f.score?.halftime?.away),
    etHome: n(f.score?.extratime?.home),
    etAway: n(f.score?.extratime?.away),
    penHome: n(f.score?.penalty?.home),
    penAway: n(f.score?.penalty?.away),
  };
  const { dataHash } = await import('../lib/hash.js');
  const hash = dataHash(payload);

  const previous = await queryOne<{ id: number; data_hash: string | null; status_short: string; finalized: boolean }>(
    `SELECT id, data_hash, status_short, finalized FROM fixtures WHERE provider = 'api-football' AND provider_fixture_id = $1`,
    [String(f.id)],
  );

  const row = await queryOne<{ id: number }>(
    `${upsertSql('fixtures', [
      'provider_fixture_id', 'competition_id', 'season_id', 'round', 'home_team_id', 'away_team_id', 'venue_id', 'referee_id',
      'timezone', 'kickoff_utc', 'status_short', 'status_long', 'status_elapsed', 'status_extra', 'postponed',
      'home_score', 'away_score', 'home_score_ht', 'away_score_ht', 'home_score_et', 'away_score_et',
      'home_score_pen', 'away_score_pen', 'importance', 'data_hash', 'last_synced_at', 'provider_updated_at', 'raw',
    ], ['provider', 'provider_fixture_id'])} RETURNING id`,
    [
      String(f.id), ids.competitionId, ids.seasonId, s(f.league?.round), ids.homeTeamId, ids.awayTeamId, ids.venueId, ids.refereeId,
      s(f.timezone) ?? 'UTC', kickoff, statusShort, s(f.status?.long), n(f.status?.elapsed), n(f.status?.extra),
      ['PST', 'ABD', 'CANC', 'SUSP'].includes(statusShort),
      payload.homeScore, payload.awayScore, payload.htHome, payload.htAway, payload.etHome, payload.etAway,
      payload.penHome, payload.penAway, s(f.league?.type), hash, new Date().toISOString(), null, JSON.stringify(f),
    ],
  );

  const fixtureId = row!.id;
  const changed = !previous || previous.data_hash !== hash;
  const completed = COMPLETED_STATUSES.has(statusShort);
  const justCompleted = completed && previous !== null && !COMPLETED_STATUSES.has(previous.status_short);

  // score phases
  await query(
    `${upsertSql('fixture_scores', ['fixture_id', 'score_type', 'home_score', 'away_score', 'raw'], ['fixture_id', 'score_type'])}`,
    [fixtureId, '1ST_HALF', payload.htHome, payload.htAway, JSON.stringify(f.score?.halftime ?? {})],
  );
  await query(
    `${upsertSql('fixture_scores', ['fixture_id', 'score_type', 'home_score', 'away_score', 'raw'], ['fixture_id', 'score_type'])}`,
    [fixtureId, 'FULL_TIME', n(f.score?.fulltime?.home), n(f.score?.fulltime?.away), JSON.stringify(f.score?.fulltime ?? {})],
  );
  if (payload.etHome != null || payload.etAway != null) {
    await query(
      `${upsertSql('fixture_scores', ['fixture_id', 'score_type', 'home_score', 'away_score', 'raw'], ['fixture_id', 'score_type'])}`,
      [fixtureId, 'EXTRA_TIME', payload.etHome, payload.etAway, JSON.stringify(f.score?.extratime ?? {})],
    );
  }
  if (payload.penHome != null || payload.penAway != null) {
    await query(
      `${upsertSql('fixture_scores', ['fixture_id', 'score_type', 'home_score', 'away_score', 'raw'], ['fixture_id', 'score_type'])}`,
      [fixtureId, 'PENALTIES', payload.penHome, payload.penAway, JSON.stringify(f.score?.penalty ?? {})],
    );
  }
  if (f.periods) {
    for (const [period, ts] of [['FIRST', f.periods.first], ['SECOND', f.periods.second]] as const) {
      if (ts) {
        await query(
          `${upsertSql('fixture_periods', ['fixture_id', 'period', 'elapsed', 'extra', 'raw'], ['fixture_id', 'period'])}`,
          [fixtureId, period, null, null, JSON.stringify({ timestamp: ts })],
        );
      }
    }
  }
  return { fixtureId, changed, completed, justCompleted };
}

const REFEREE_COUNTRIES = new Set([
  'Algeria', 'Argentina', 'Austria', 'Belgium', 'Benin',
  'Bolivia', 'Bosnia & Herzegovina', 'Brazil', 'Bulgaria', 'Burundi',
  'Cameroon', 'Chad', 'Chile', 'Colombia', 'Congo Republic',
  "Côte d'Ivoire", 'Croatia', 'DR Congo', 'Ecuador', 'Egypt',
  'France', 'Gabon', 'Germany', 'Ghana', 'Greece', 'Hungary',
  'Kenya', 'Lithuania', 'Mali', 'Mauritania', 'Mauritius',
  'Montenegro', 'Morocco', 'Netherlands', 'Peru', 'Poland',
  'Romania', 'Russia', 'Rwanda', 'Saudi Arabia', 'Scotland',
  'Senegal', 'Slovenia', 'Somalia', 'South Africa', 'Spain',
  'Sudan', 'Sweden', 'Switzerland', 'Tunisia', 'Uganda',
  'Uruguay', 'Venezuela',
]);

function refereeNationalityFromFixtureName(name: string): string | null {
  const parts = name.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const suffix = parts[parts.length - 1];
  return REFEREE_COUNTRIES.has(suffix) ? suffix : null;
}

export async function resolveRefereeByName(name: string | null): Promise<number | null> {
  const t = s(name);
  if (!t) return null;
  const nationality = refereeNationalityFromFixtureName(t);
  const existing = await queryOne<{ id: number; nationality: string | null }>(
    `SELECT id, nationality FROM referees WHERE lower(name) = lower($1) LIMIT 1`,
    [t],
  );
  if (existing) {
    if (!existing.nationality && nationality) {
      await query(
        `UPDATE referees SET nationality = $2, updated_at = now()
          WHERE id = $1 AND nationality IS NULL`,
        [existing.id, nationality],
      );
    }
    return existing.id;
  }
  return upsertReferee({ id: null, name: t, country: nationality });
}

export async function replaceFixtureEvents(fixtureId: number, events: AfEvent[]): Promise<number> {
  // Events come in complete snapshots — replace-in-transaction keeps idempotency.
  await query(`DELETE FROM fixture_events WHERE fixture_id = $1`, [fixtureId]);
  let count = 0;
  for (const e of events) {
    const teamProvId = e.team?.id;
    const team = teamProvId != null
      ? await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(teamProvId)])
      : null;
    const player = e.player?.id != null
      ? await queryOne<{ id: number }>(`SELECT id FROM players WHERE provider_id = $1`, [String(e.player.id)])
      : null;
    const assist = e.assist?.id != null
      ? await queryOne<{ id: number }>(`SELECT id FROM players WHERE provider_id = $1`, [String(e.assist.id)])
      : null;
    const fx = await queryOne<{ home_team_id: number | null }>(`SELECT home_team_id FROM fixtures WHERE id = $1`, [fixtureId]);
    const isHome = team?.id != null && fx?.home_team_id != null ? team.id === fx.home_team_id : null;
    try {
      await query(
        `INSERT INTO fixture_events
          (fixture_id, team_id, player_id, assist_player_id, event_type, event_detail, comments, elapsed, extra, time_label, is_home, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (fixture_id, provider_event_id, elapsed, extra, event_type, event_detail, player_id) DO UPDATE SET updated_at = now()`,
        [
          fixtureId, team?.id ?? null, player?.id ?? null, assist?.id ?? null,
          s(e.type) ?? 'Unknown', s(e.detail), s(e.comments),
          n(e.time?.elapsed), n(e.time?.extra),
          e.time?.extra != null ? `${e.time?.elapsed}+${e.time?.extra}` : s(e.time?.elapsed),
          isHome, JSON.stringify(e),
        ],
      );
      count += 1;
    } catch {
      // constraint clash on NULL provider_event_id combos: insert without conflict target
      await query(
        `INSERT INTO fixture_events
          (fixture_id, team_id, player_id, assist_player_id, event_type, event_detail, comments, elapsed, extra, time_label, is_home, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          fixtureId, team?.id ?? null, player?.id ?? null, assist?.id ?? null,
          s(e.type) ?? 'Unknown', s(e.detail), s(e.comments),
          n(e.time?.elapsed), n(e.time?.extra),
          e.time?.extra != null ? `${e.time?.elapsed}+${e.time?.extra}` : s(e.time?.elapsed),
          isHome, JSON.stringify(e),
        ],
      );
      count += 1;
    }
  }
  return count;
}

const TEAM_STAT_MAP: Record<string, [string, 'int' | 'num' | 'pct']> = {
  'shots on goal': ['shots_on_target', 'int'],
  'shots off goal': ['shots_off_target', 'int'],
  'total shots': ['shots_total', 'int'],
  'blocked shots': ['shots_blocked', 'int'],
  'shots insidebox': ['shots_inside_box', 'int'],
  'shots outsidebox': ['shots_outside_box', 'int'],
  'ball possession': ['possession_pct', 'pct'],
  'total passes': ['passes_total', 'int'],
  'passes accurate': ['passes_accurate', 'int'],
  'passes %': ['pass_accuracy_pct', 'pct'],
  'corner kicks': ['corners', 'int'],
  offsides: ['offsides', 'int'],
  fouls: ['fouls', 'int'],
  'yellow cards': ['yellow_cards', 'int'],
  'red cards': ['red_cards', 'int'],
  'goalkeeper saves': ['goalkeeper_saves', 'int'],
  expected_goals: ['expected_goals', 'num'],
  crosses: ['crosses', 'int'],
  'crosses accurate': ['crosses_accurate', 'int'],
  tackles: ['tackles', 'int'],
  interceptions: ['interceptions', 'int'],
  clearances: ['clearances', 'int'],
  blocks: ['blocks', 'int'],
  duels: ['duels_total', 'int'],
  'duels won': ['duels_won', 'int'],
  'aerial duels': ['aerials_total', 'int'],
  'aerial duels won': ['aerials_won', 'int'],
  dribbles: ['dribbles_attempts', 'int'],
  'dribbles success': ['dribbles_success', 'int'],
};

const TEAM_STAT_COLS = [...new Set(Object.values(TEAM_STAT_MAP).map(([c]) => c))];

export async function upsertFixtureTeamStatistics(fixtureId: number, entries: AfTeamStatEntry[]): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    const team = entry.team?.id != null
      ? await queryOne<{ id: number; home: boolean }>(
          `SELECT t.id, (f.home_team_id = t.id) AS home FROM teams t JOIN fixtures f ON f.id = $2 WHERE t.provider_id = $1`,
          [String(entry.team.id), fixtureId],
        )
      : null;
    if (!team) continue;
    const values: Record<string, number | null> = Object.fromEntries(TEAM_STAT_COLS.map((c) => [c, null]));
    const extra: Record<string, unknown> = {};
    for (const stat of entry.statistics ?? []) {
      const key = (stat.type ?? '').toLowerCase();
      const mapped = TEAM_STAT_MAP[key];
      if (mapped) {
        values[mapped[0]] = mapped[1] === 'int' ? n(stat.value) : mapped[1] === 'num' ? num3(stat.value) : n(stat.value);
      } else if (stat.type) {
        extra[stat.type] = stat.value;
      }
    }
    await query(
      `${upsertSql(
        'fixture_team_statistics',
        ['fixture_id', 'team_id', 'is_home', ...TEAM_STAT_COLS, 'extra_stats', 'raw', 'provider_stat_key'],
        ['fixture_id', 'team_id'],
      )}`,
      [fixtureId, team.id, team.home, ...TEAM_STAT_COLS.map((c) => values[c]), JSON.stringify(extra), JSON.stringify(entry), entry.team?.id ? `api-ft:${entry.team.id}` : null],
    );
    count += 1;
  }
  return count;
}

export async function upsertPlayerMatchStatistics(fixtureId: number, entries: AfPlayerStatEntry[]): Promise<number> {
  let count = 0;
  for (const teamEntry of entries) {
    const team = teamEntry.team?.id != null
      ? await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(teamEntry.team.id)])
      : null;
    for (const row of teamEntry.players ?? []) {
      const playerProvId = row.player?.id;
      if (playerProvId == null) continue;
      const player = await queryOne<{ id: number }>(
        `${upsertSql('players', ['name', 'first_name', 'last_name', 'age', 'nationality', 'photo_url', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
        [
          s(row.player?.name) ?? `Player ${playerProvId}`, s(row.player?.firstname), s(row.player?.lastname),
          n(row.player?.age), s(row.player?.nationality), s(row.player?.photo), String(playerProvId), JSON.stringify(row.player ?? {}),
        ],
      );
      if (!player || !team) continue;
      const line = row.statistics?.[0];
      if (!line) continue;
      const shots = line.shots ?? {};
      const goals = (line as { goals?: Record<string, unknown> }).goals ?? {};
      const passes = line.passes ?? {};
      const tackles = line.tackles ?? {};
      const dribbles = line.dribbles ?? {};
      const duels = line.duels ?? {};
      const fouls = line.fouls ?? {};
      const cards = line.cards ?? {};
      const penalty = line.penalty ?? {};
      const games = line.games ?? {};
      await query(
        `${upsertSql('player_match_statistics', [
          'fixture_id', 'team_id', 'player_id', 'minutes', 'rating', 'position', 'captain', 'substitute',
          'shots_total', 'shots_on_target', 'goals', 'conceded_goals', 'assists', 'saves',
          'passes_total', 'passes_accurate', 'key_passes', 'tackles', 'blocks', 'interceptions', 'clearances',
          'duels_total', 'duels_won', 'dribbles_attempts', 'dribbles_success',
          'fouls_committed', 'fouls_drawn', 'yellow_cards', 'second_yellow', 'red_cards',
          'penalties_won', 'penalties_committed', 'penalty_goals', 'penalty_missed', 'penalty_saved',
          'raw',
        ], ['fixture_id', 'player_id'])}`,
        [
          fixtureId, team.id, player.id,
          n(games.minutes), num3(games.rating), s(games.position), b(games.captain), b(games.substitute),
          n(shots.total) !== null ? n(shots.total) : null,
          n(shots.on),
          n(goals.total), n(goals.conceded), n(goals.assists), n(goals.saves),
          n(passes.total), n(passes.accuracy) != null && n(passes.total) ? Math.round((n(passes.accuracy)! / 100) * n(passes.total)!) : null,
          n(passes.key),
          n(tackles.total), n(tackles.blocks), n(tackles.interceptions),
          n((tackles as { clearances?: unknown }).clearances),
          n(duels.total), n(duels.won),
          n(dribbles.attempts), n(dribbles.success),
          n(fouls.committed), n(fouls.drawn),
          n(cards.yellow), n(cards.yellowred), n(cards.red),
          n(penalty.won), n(penalty.committed), n(penalty.scored), n(penalty.missed), n(penalty.saved),
          JSON.stringify(row),
        ],
      );
      count += 1;
    }
  }
  return count;
}

export async function upsertLineups(fixtureId: number, lineups: AfLineup[]): Promise<number> {
  let count = 0;
  for (const lu of lineups) {
    const team = lu.team?.id != null
      ? await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(lu.team.id)])
      : null;
    if (!team) continue;
    const row = await queryOne<{ id: number }>(
      `${upsertSql('lineups', ['fixture_id', 'team_id', 'formation', 'coach_name', 'coach_id', 'raw'], ['fixture_id', 'team_id'])} RETURNING id`,
      [fixtureId, team.id, s(lu.formation), s(lu.coach?.name), lu.coach?.id != null ? String(lu.coach.id) : null, JSON.stringify(lu)],
    );
    const lineupId = row!.id;
    await query(`DELETE FROM lineup_players WHERE lineup_id = $1`, [lineupId]);
    const rows: [AfLineupPlayer | null | undefined, boolean][] = [
      ...(lu.startXI ?? []).map((x) => [x.player, true] as [AfLineupPlayer | null, boolean]),
      ...(lu.substitutes ?? []).map((x) => [x.player, false] as [AfLineupPlayer | null, boolean]),
    ];
    for (const [p, starting] of rows) {
      if (!p) continue;
      const player = p.id != null
        ? await queryOne<{ id: number }>(
            `${upsertSql('players', ['name', 'photo_url', 'provider_id', 'raw'], ['provider', 'provider_id'])} RETURNING id`,
            [s(p.name) ?? `Player ${p.id}`, null, String(p.id), JSON.stringify(p)],
          )
        : null;
      await query(
        `INSERT INTO lineup_players (lineup_id, player_id, team_id, number, name, position, grid_position, is_starting, is_substitute, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (lineup_id, player_id, number, name) DO UPDATE SET updated_at = now()`,
        [lineupId, player?.id ?? null, team.id, n(p.number), s(p.name), s(p.pos), s(p.grid), starting, !starting, JSON.stringify(p)],
      );
    }
    count += 1;
  }
  return count;
}

export async function replaceStandings(competitionSeasonId: number, entries: AfStandingsEntry[]): Promise<number> {
  await query(`DELETE FROM standings WHERE competition_season_id = $1`, [competitionSeasonId]);
  let rows = 0;
  for (const entry of entries) {
    for (const group of entry.league?.standings ?? []) {
      const st = await queryOne<{ id: number }>(
        `INSERT INTO standings (competition_season_id, group_name, raw) VALUES ($1, $2, $3) RETURNING id`,
        [competitionSeasonId, entry.league?.name ?? null, JSON.stringify(entry)],
      );
      for (const r of group as AfStandingRow[]) {
        const team = r.team?.id != null
          ? await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(r.team.id)])
          : null;
        if (!team) continue;
        await query(
          `${upsertSql('standing_rows', [
            'standings_id', 'team_id', 'rank', 'points', 'played', 'wins', 'draws', 'losses',
            'goals_for', 'goals_against', 'goal_diff', 'form', 'description', 'status', 'all_stats', 'home_stats', 'away_stats', 'raw',
          ], ['standings_id', 'team_id'])}`,
          [
            st!.id, team.id, n(r.rank), n(r.points),
            n(r.all?.played), n(r.all?.win), n(r.all?.draw), n(r.all?.lose),
            n(r.all?.goals?.for), n(r.all?.goals?.against), n(r.goalsDiff),
            s(r.form), s(r.description), s(r.status),
            JSON.stringify(r.all ?? {}), JSON.stringify(r.home ?? {}), JSON.stringify(r.away ?? {}),
            JSON.stringify(r),
          ],
        );
        rows += 1;
      }
    }
  }
  return rows;
}

export async function upsertSidelined(rec: AfInjury, ids: { playerId: number | null; teamId: number | null; competitionId: number | null; seasonId: number | null; fixtureId?: number | null }): Promise<boolean> {
  if (ids.playerId == null) return false;
  const providerId = `${ids.playerId}:${rec.type?.start ?? ''}:${rec.type?.reason ?? ''}`;
  const res = await execute(
    `INSERT INTO sidelined_records (player_id, team_id, competition_id, season_id, type, reason, start_date, end_date, provider_endpoint, provider_id, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'injuries',$9,$10)
     ON CONFLICT (provider, provider_id) DO UPDATE SET reason = EXCLUDED.reason, end_date = EXCLUDED.end_date, updated_at = now()`,
    [
      ids.playerId, ids.teamId, ids.competitionId, ids.seasonId,
      s(rec.type?.reason) ? 'injury' : 'absence', s(rec.type?.reason),
      dateOnly(rec.type?.start), dateOnly(rec.type?.end), providerId, JSON.stringify(rec),
    ],
  );
  return res > 0;
}

export async function upsertTransfer(rec: AfTransfer, ids: { playerId: number | null; fromTeamId: number | null; toTeamId: number | null }): Promise<boolean> {
  if (ids.playerId == null) return false;
  const providerEventId = `${ids.playerId}:${rec.date ?? rec.update ?? ''}:${rec.type ?? ''}:${ids.fromTeamId}->${ids.toTeamId}`;
  const res = await execute(
    `INSERT INTO transfers (player_id, from_team_id, to_team_id, transfer_date, transfer_type, provider_event_id, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (player_id, from_team_id, to_team_id, transfer_date, transfer_type, provider_event_id) DO NOTHING`,
    [ids.playerId, ids.fromTeamId, ids.toTeamId, dateOnly(rec.date ?? rec.update), s(rec.type) ?? 'N/A', providerEventId, JSON.stringify(rec)],
  );
  return res > 0;
}

export function isLiveStatus(statusShort: string | null): boolean {
  return statusShort != null && LIVE_STATUSES.has(statusShort as never);
}
