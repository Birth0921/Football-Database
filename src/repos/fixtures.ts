import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { upsertTeam, upsertVenue, upsertReferee, upsertCompetitionRound, upsertCompetitionSeason, resolveCompetitionSeason, upsertPlayer, upsertPlayerTeamHistory, upsertTeamSeason } from './lookups.js';
import { mapTeam, mapVenue, type TeamRow, type VenueRow } from '../mapping/teams.js';
import { mapPlayer } from '../mapping/fixtures.js';
import type { FixtureRow, EventRow, TeamStatsRow, PlayerMatchStatsRow, LineupRow, StandingRowData, InjuryRowData, TransferRowData, OddsRowData, PlayerRowData } from '../mapping/fixtures.js';
import { sha256, nameKey } from '../util/hash.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'repos-fixtures' });

function fixtureDataHash(row: FixtureRow): string {
  return sha256(
    JSON.stringify([row.statusShort, row.homeScore, row.awayScore, row.ht, row.ft, row.et, row.pen, row.statusElapsed, row.postponed]),
  );
}

/** Upsert a fixture (idempotent on provider + provider_fixture_id). Returns internal fixture id and whether it changed. */
export async function upsertFixture(row: FixtureRow): Promise<{ id: number; changed: boolean }> {
  // ensure teams exist
  const homeTeamId = await upsertTeam({ ...emptyTeam(row.homeTeam.providerId, row.homeTeam.name), logoUrl: row.homeTeam.logo ?? null } as TeamRow);
  const awayTeamId = await upsertTeam({ ...emptyTeam(row.awayTeam.providerId, row.awayTeam.name), logoUrl: row.awayTeam.logo ?? null } as TeamRow);

  // ensure competition season exists (imported coverage usually already did)
  let cs = await resolveCompetitionSeason(row.competitionProviderId, row.seasonYear);
  if (!cs) {
    cs = await upsertCompetitionSeason(
      { providerId: row.competitionProviderId, name: `League ${row.competitionProviderId}`, type: 'league', country: null, logoUrl: null },
      { year: row.seasonYear, startDate: null, endDate: null, isCurrent: false },
    );
  }
  await upsertTeamSeason(homeTeamId, cs.competitionSeasonId);
  await upsertTeamSeason(awayTeamId, cs.competitionSeasonId);

  const venueId = row.venue ? await upsertVenue(mapVenue(row.venue as unknown as Parameters<typeof mapVenue>[0])) : null;
  void 0;
  const refereeId = row.referee ? await upsertReferee(row.referee.name, row.referee.country) : null;
  let roundId: number | null = null;
  if (row.roundName) roundId = await upsertCompetitionRound(cs.competitionSeasonId, row.roundName);

  const hash = fixtureDataHash(row);
  // capture previous hash for change detection (RETURNING sees the new row only)
  const prev = (
    await query<{ id: number; data_hash: string | null; finalized_at: Date | null }>(
      `SELECT id, data_hash, finalized_at FROM fixtures WHERE provider = 'api-football' AND provider_id = $1`,
      [row.providerId],
    )
  ).rows[0];
  const { rows } = await query<{ id: number; data_hash: string | null }>(
    `INSERT INTO fixtures (
       provider, provider_id, competition_season_id, competition_id, season_year, round_id, round_name,
       home_team_id, away_team_id, venue_id, referee_id, timezone, kickoff_at, kickoff_date,
       status_short, status_long, status_elapsed, is_finished, has_extra_time, postponed, cancelled,
       winner_team_id, home_score, away_score,
       ht_home_score, ht_away_score, ft_home_score, ft_away_score, et_home_score, et_away_score,
       pen_home_score, pen_away_score, data_hash, raw
     ) VALUES (
       'api-football', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20,
       NULL,
       $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32::jsonb
     )
     ON CONFLICT (provider, provider_id) DO UPDATE SET
       competition_season_id = EXCLUDED.competition_season_id,
       round_id = EXCLUDED.round_id,
       round_name = EXCLUDED.round_name,
       venue_id = COALESCE(EXCLUDED.venue_id, fixtures.venue_id),
       referee_id = COALESCE(EXCLUDED.referee_id, fixtures.referee_id),
       status_short = EXCLUDED.status_short,
       status_long = EXCLUDED.status_long,
       status_elapsed = EXCLUDED.status_elapsed,
       is_finished = EXCLUDED.is_finished,
       has_extra_time = EXCLUDED.has_extra_time,
       postponed = EXCLUDED.postponed,
       cancelled = EXCLUDED.cancelled,
       home_score = EXCLUDED.home_score,
       away_score = EXCLUDED.away_score,
       ht_home_score = EXCLUDED.ht_home_score, ht_away_score = EXCLUDED.ht_away_score,
       ft_home_score = EXCLUDED.ft_home_score, ft_away_score = EXCLUDED.ft_away_score,
       et_home_score = EXCLUDED.et_home_score, et_away_score = EXCLUDED.et_away_score,
       pen_home_score = EXCLUDED.pen_home_score, pen_away_score = EXCLUDED.pen_away_score,
       data_hash = EXCLUDED.data_hash,
       raw = EXCLUDED.raw,
       updated_at = now()
     RETURNING id, data_hash`,
    [
      row.providerId, cs.competitionSeasonId, cs.competitionId, row.seasonYear, roundId, row.roundName,
      homeTeamId, awayTeamId, venueId, refereeId, row.timezone, row.kickoffAt, row.kickoffDate,
      row.statusShort, row.statusLong, row.statusElapsed, row.isFinished, row.hasExtraTime, row.postponed, row.cancelled,
      row.homeScore, row.awayScore,
      row.ht[0], row.ht[1], row.ft[0], row.ft[1], row.et[0], row.et[1], row.pen[0], row.pen[1],
      hash, JSON.stringify(row.raw),
    ],
  );

  // resolved team ids for winner (provider id -> internal id, including reset to NULL)
  const winnerId = row.winnerProviderId
    ? (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [row.winnerProviderId])).rows[0]?.id ?? null
    : null;
  await query(`UPDATE fixtures SET winner_team_id = $2 WHERE id = $1 AND (winner_team_id IS DISTINCT FROM $2)`, [rows[0].id, winnerId]);

  // fixture scores period rows
  await withTransaction(async (client) => {
    const periods: [string, string | null, string | null][] = [['first_half', null, null], ['second_half', null, null]];
    for (const [name, started, ended] of periods) {
      await client.query(
        `INSERT INTO fixture_periods (fixture_id, name, started_at, ended_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (fixture_id, name) DO UPDATE SET started_at = COALESCE(EXCLUDED.started_at, fixture_periods.started_at)`,
        [rows[0].id, name, started, ended],
      );
    }
    const scores: [string, number | null, number | null][] = [
      ['HT', row.ht[0], row.ht[1]],
      ['FT', row.ft[0], row.ft[1]],
      ['ET', row.et[0], row.et[1]],
      ['PEN', row.pen[0], row.pen[1]],
    ];
    for (const [period, home, away] of scores) {
      if (home === null && away === null) continue;
      await client.query(
        `INSERT INTO fixture_scores (fixture_id, period, home_value, away_value) VALUES ($1,$2,$3,$4)
         ON CONFLICT (fixture_id, period) DO UPDATE SET home_value = EXCLUDED.home_value, away_value = EXCLUDED.away_value`,
        [rows[0].id, period, home, away],
      );
    }
  });

  return { id: rows[0].id, changed: prev ? prev.data_hash !== hash : true };
}

function emptyTeam(providerId: number, name: string): TeamRow {
  return { providerId, name, shortName: null, code: null, country: null, founded: null, logoUrl: null, isNational: false, venue: null };
}

/** Idempotent event storage: deletes+reinserts would break history; upsert per event_key. */
export async function storeFixtureEvents(fixtureId: number, events: EventRow[]): Promise<number> {
  if (!events.length) return 0;
  const client = await (await import('../db/pool.js')).pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of events) {
      const teamId = e.teamProviderId ? await lookupId(client, 'teams', e.teamProviderId) : null;
      const playerId = e.playerProviderId ? await ensurePlayer(client, e.playerProviderId, e.playerName) : null;
      const assistId = e.assistProviderId ? await ensurePlayer(client, e.assistProviderId, e.assistName) : null;
      await client.query(
        `INSERT INTO fixture_events (fixture_id, team_id, player_id, assist_player_id, player_name, assist_name,
            event_type, event_detail, comments, minute, extra_minute, is_var, event_key, sort_order, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         ON CONFLICT (fixture_id, event_key) DO UPDATE SET
           event_detail = COALESCE(EXCLUDED.event_detail, fixture_events.event_detail),
           comments = COALESCE(EXCLUDED.comments, fixture_events.comments),
           raw = EXCLUDED.raw`,
        [
          fixtureId, teamId, playerId, assistId, e.playerName, e.assistName,
          e.eventType, e.eventDetail, e.comments, e.minute, e.extraMinute, e.isVar, e.eventKey, e.sortOrder,
          JSON.stringify(e.raw),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return events.length;
}

async function lookupId(client: import('pg').PoolClient, table: string, providerId: number): Promise<number | null> {
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE provider='api-football' AND provider_id=$1 LIMIT 1`, [providerId],
  );
  return rows[0]?.id ?? null;
}

async function ensurePlayer(client: import('pg').PoolClient, providerId: number, name: string | null): Promise<number | null> {
  const existing = await lookupId(client, 'players', providerId);
  if (existing) return existing;
  if (!name) return null;
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO players (provider, provider_id, name) VALUES ('api-football', $1, $2)
     ON CONFLICT (provider, provider_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [providerId, name],
  );
  return rows[0]?.id ?? null;
}

export async function storeFixtureTeamStats(fixtureId: number, stats: TeamStatsRow[]): Promise<number> {
  let n = 0;
  for (const s of stats ?? []) {
    const teamId = (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [s.teamProviderId])).rows[0]?.id;
    if (!teamId) continue;
    await query(
      `INSERT INTO fixture_team_statistics (fixture_id, team_id, shots_total, shots_on_goal, shots_off_goal, shots_blocked,
          shots_inside_box, shots_outside_box, fouls, corners, offsides, possession_pct, yellow_cards, red_cards,
          goalkeeper_saves, total_passes, accurate_passes, pass_accuracy_pct, expected_goals, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
       ON CONFLICT (fixture_id, team_id) DO UPDATE SET
         shots_total=EXCLUDED.shots_total, shots_on_goal=EXCLUDED.shots_on_goal, shots_off_goal=EXCLUDED.shots_off_goal,
         shots_blocked=EXCLUDED.shots_blocked, shots_inside_box=EXCLUDED.shots_inside_box, shots_outside_box=EXCLUDED.shots_outside_box,
         fouls=EXCLUDED.fouls, corners=EXCLUDED.corners, offsides=EXCLUDED.offsides, possession_pct=EXCLUDED.possession_pct,
         yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards, goalkeeper_saves=EXCLUDED.goalkeeper_saves,
         total_passes=EXCLUDED.total_passes, accurate_passes=EXCLUDED.accurate_passes, pass_accuracy_pct=EXCLUDED.pass_accuracy_pct,
         expected_goals=COALESCE(EXCLUDED.expected_goals, fixture_team_statistics.expected_goals),
         raw=EXCLUDED.raw, updated_at=now()`,
      [
        fixtureId, teamId, s.shotsTotal, s.shotsOnGoal, s.shotsOffGoal, s.shotsBlocked, s.shotsInsideBox,
        s.shotsOutsideBox, s.fouls, s.corners, s.offsides, s.possessionPct, s.yellowCards, s.redCards,
        s.goalkeeperSaves, s.totalPasses, s.accuratePasses, s.passAccuracyPct, s.expectedGoals, JSON.stringify(s.raw),
      ],
    );
    n++;
  }
  return n;
}

export async function storePlayerMatchStats(
  fixtureId: number,
  stats: PlayerMatchStatsRow[],
  opts: { competitionSeasonId?: number } = {},
): Promise<number> {
  let n = 0;
  for (const s of stats ?? []) {
    const playerId = await upsertPlayer(mapPlayerFromMatch(s));
    const teamId = (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [s.teamProviderId])).rows[0]?.id;
    if (!teamId) continue;
    if (opts.competitionSeasonId) await upsertPlayerTeamHistory(playerId, teamId, opts.competitionSeasonId);
    await query(
      `INSERT INTO player_match_statistics (fixture_id, player_id, team_id, minutes_played, rating, position, is_captain, is_substitute,
          shots_total, shots_on_goal, goals, assists, saves, passes_total, passes_accurate, pass_accuracy_pct, key_passes,
          tackles, blocks, interceptions, duels_total, duels_won, dribbles_attempts, dribbles_success,
          fouls_drawn, fouls_committed, yellow_cards, yellowred_cards, red_cards,
          penalty_won, penalty_committed, penalty_scored, penalty_missed, goals_conceded, clean_sheet, expected_goals, expected_assists, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38::jsonb)
       ON CONFLICT (fixture_id, player_id) DO UPDATE SET
         team_id=EXCLUDED.team_id, minutes_played=EXCLUDED.minutes_played, rating=EXCLUDED.rating, position=EXCLUDED.position,
         is_captain=EXCLUDED.is_captain, is_substitute=EXCLUDED.is_substitute,
         shots_total=EXCLUDED.shots_total, shots_on_goal=EXCLUDED.shots_on_goal, goals=EXCLUDED.goals, assists=EXCLUDED.assists,
         saves=EXCLUDED.saves, passes_total=EXCLUDED.passes_total, passes_accurate=EXCLUDED.passes_accurate,
         pass_accuracy_pct=EXCLUDED.pass_accuracy_pct, key_passes=player_match_statistics.key_passes,
         tackles=EXCLUDED.tackles, blocks=EXCLUDED.blocks, interceptions=EXCLUDED.interceptions,
         duels_total=EXCLUDED.duels_total, duels_won=EXCLUDED.duels_won,
         dribbles_attempts=EXCLUDED.dribbles_attempts, dribbles_success=EXCLUDED.dribbles_success,
         fouls_drawn=EXCLUDED.fouls_drawn, fouls_committed=EXCLUDED.fouls_committed,
         yellow_cards=EXCLUDED.yellow_cards, yellowred_cards=EXCLUDED.yellowred_cards, red_cards=EXCLUDED.red_cards,
         penalty_won=EXCLUDED.penalty_won, penalty_committed=EXCLUDED.penalty_committed,
         penalty_scored=EXCLUDED.penalty_scored, penalty_missed=EXCLUDED.penalty_missed,
         goals_conceded=EXCLUDED.goals_conceded, clean_sheet=EXCLUDED.clean_sheet, raw=EXCLUDED.raw, updated_at=now()`,
      [
        fixtureId, playerId, teamId, s.minutesPlayed, s.rating, s.position, s.isCaptain, s.isSubstitute,
        s.shotsTotal, s.shotsOnGoal, s.goals, s.assists, s.saves, s.passesTotal, s.passesAccurate, s.passAccuracyPct, s.keyPasses,
        s.tackles, s.blocks, s.interceptions, s.duelsTotal, s.duelsWon, s.dribblesAttempts, s.dribblesSuccess,
        s.foulsDrawn, s.foulsCommitted, s.yellowCards, s.yellowredCards, s.redCards,
        s.penaltyWon, s.penaltyCommitted, s.penaltyScored, s.penaltyMissed, s.goalsConceded, s.cleanSheet,
        s.expectedGoals, s.expectedAssists, JSON.stringify(s.raw),
      ],
    );
    n++;
  }
  return n;
}

function mapPlayerFromMatch(s: PlayerMatchStatsRow): PlayerRowData {
  return {
    providerId: s.player.providerId,
    name: s.player.name,
    firstname: null, lastname: null,
    nationality: null, birthDate: null, birthPlace: null, birthCountry: null,
    age: null, height: null, weight: null,
    injured: null, photo: s.player.photo ?? null,
  };
}

export async function storeLineups(fixtureId: number, lineups: LineupRow[]): Promise<number> {
  let n = 0;
  for (const l of lineups ?? []) {
    const teamId = (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [l.teamProviderId])).rows[0]?.id;
    if (!teamId) continue;
    let coachId: number | null = null;
    if (l.coach?.providerId) {
      coachId = (await query<{ id: number }>(`SELECT id FROM coaches WHERE provider='api-football' AND provider_id=$1`, [l.coach.providerId])).rows[0]?.id ?? null;
    }
    const { rows } = await query<{ id: number }>(
      `INSERT INTO lineups (fixture_id, team_id, formation, coach_id, coach_name)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fixture_id, team_id) DO UPDATE SET formation=EXCLUDED.formation,
         coach_id=COALESCE(EXCLUDED.coach_id, lineups.coach_id), coach_name=COALESCE(EXCLUDED.coach_name, lineups.coach_name),
         updated_at=now() RETURNING id`,
      [fixtureId, teamId, l.formation, coachId, l.coach?.name ?? null],
    );
    const lineupId = rows[0].id;
    for (const p of l.players) {
      let playerId: number | null = p.playerProviderId
        ? (await query<{ id: number }>(`SELECT id FROM players WHERE provider='api-football' AND provider_id=$1`, [p.playerProviderId])).rows[0]?.id ?? null
        : null;
      if (!playerId && p.playerProviderId && p.playerName) {
        playerId = (await query<{ id: number }>(
          `INSERT INTO players (provider, provider_id, name) VALUES ('api-football', $1, $2)
           ON CONFLICT (provider, provider_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
          [p.playerProviderId, p.playerName],
        )).rows[0].id;
      }
      await query(
        `INSERT INTO lineup_players (lineup_id, player_id, player_name, shirt_number, position, grid_position, is_starting, is_captain)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (lineup_id, coalesce(player_id, -1), player_name, is_starting) DO NOTHING`,
        [lineupId, playerId, p.playerName, p.shirtNumber, p.position, p.gridPosition, p.isStarting, p.isCaptain],
      );
    }
    n++;
  }
  return n;
}

export async function storeStandings(competitionSeasonId: number, rows: StandingRowData[], providerUpdatedAt: string | null): Promise<number> {
  if (!rows.length) return 0;
  const standings = await query<{ id: number }>(
    `INSERT INTO standings (competition_season_id, group_name, provider_updated_at)
     VALUES ($1, 'default', $2) RETURNING id`,
    [competitionSeasonId, providerUpdatedAt],
  ).catch(async () => {
    // unique conflict: update instead
    const upd = await query<{ id: number }>(
      `UPDATE standings SET provider_updated_at = COALESCE($2, provider_updated_at), updated_at = now()
       WHERE competition_season_id = $1 RETURNING id`,
      [competitionSeasonId, providerUpdatedAt],
    );
    return upd;
  });
  const standingsId = standings.rows[0].id;
  let n = 0;
  for (const r of rows) {
    const teamId = (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [r.teamProviderId])).rows[0]?.id;
    if (!teamId) continue;
    await query(
      `INSERT INTO standing_rows (standings_id, team_id, rank, points, played, wins, draws, losses, goals_for, goals_against,
          goal_difference, form, description,
          home_played, home_wins, home_draws, home_losses, home_goals_for, home_goals_against,
          away_played, away_wins, away_draws, away_losses, away_goals_for, away_goals_against, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb)
       ON CONFLICT (standings_id, team_id) DO UPDATE SET
         rank=EXCLUDED.rank, points=EXCLUDED.points, played=EXCLUDED.played, wins=EXCLUDED.wins, draws=EXCLUDED.draws,
         losses=EXCLUDED.losses, goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
         goal_difference=EXCLUDED.goal_difference, form=EXCLUDED.form, description=EXCLUDED.description,
         home_played=EXCLUDED.home_played, home_wins=EXCLUDED.home_wins, home_draws=EXCLUDED.home_draws,
         home_losses=EXCLUDED.home_losses, home_goals_for=EXCLUDED.home_goals_for, home_goals_against=EXCLUDED.home_goals_against,
         away_played=EXCLUDED.away_played, away_wins=EXCLUDED.away_wins, away_draws=EXCLUDED.away_draws,
         away_losses=EXCLUDED.away_losses, away_goals_for=EXCLUDED.away_goals_for, away_goals_against=EXCLUDED.away_goals_against,
         raw=EXCLUDED.raw`,
      [
        standingsId, teamId, r.rank, r.points, r.played, r.wins, r.draws, r.losses, r.goalsFor, r.goalsAgainst,
        r.goalDifference, r.form, r.description,
        r.home?.played ?? null, r.home?.win ?? null, r.home?.draw ?? null, r.home?.lose ?? null, r.home?.gf ?? null, r.home?.ga ?? null,
        r.away?.played ?? null, r.away?.win ?? null, r.away?.draw ?? null, r.away?.lose ?? null, r.away?.gf ?? null, r.away?.ga ?? null,
        JSON.stringify(r.raw),
      ],
    );
    n++;
  }
  return n;
}

export async function storeInjuries(rows: InjuryRowData[]): Promise<number> {
  let n = 0;
  for (const r of rows ?? []) {
    const playerId = await upsertPlayer(mapPlayer({ id: r.player.providerId, name: r.player.name } as never));
    const teamId = r.teamProviderId
      ? (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [r.teamProviderId])).rows[0]?.id ?? null
      : null;
    const fixtureId = r.fixtureProviderId
      ? (await query<{ id: number }>(`SELECT id FROM fixtures WHERE provider='api-football' AND provider_id=$1`, [r.fixtureProviderId])).rows[0]?.id ?? null
      : null;
    let csId: number | null = null;
    if (r.competitionProviderId && r.seasonYear) {
      csId = (await resolveCompetitionSeason(r.competitionProviderId, r.seasonYear))?.competitionSeasonId ?? null;
    }
    const dedupeKey = sha256(['injuries', r.player.providerId, r.fixtureProviderId ?? '-', r.recordType, r.reason ?? ''].join('|'));
    await query(
      `INSERT INTO sidelined_records (provider, provider_source, player_id, team_id, fixture_id, competition_season_id,
          record_type, reason, dedupe_key, raw)
       VALUES ('api-football', 'injuries', $1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET reason = COALESCE(EXCLUDED.reason, sidelined_records.reason), updated_at = now()`,
      [playerId, teamId, fixtureId, csId, r.recordType, r.reason, dedupeKey, JSON.stringify(r)],
    );
    n++;
  }
  return n;
}

export async function storeTransfers(rows: TransferRowData[]): Promise<number> {
  let n = 0;
  for (const r of rows ?? []) {
    const playerId = await upsertPlayer(mapPlayer({ id: r.player.providerId, name: r.player.name } as never));
    const fromId = r.sourceTeamProviderId
      ? (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [r.sourceTeamProviderId])).rows[0]?.id ?? null
      : null;
    const toId = r.destinationTeamProviderId
      ? (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [r.destinationTeamProviderId])).rows[0]?.id ?? null
      : null;
    await query(
      `INSERT INTO transfers (provider, provider_transfer_id, player_id, source_team_id, destination_team_id,
          transfer_date, transfer_type, is_loan, fee, raw)
       VALUES ('api-football', $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (player_id, coalesce(transfer_date, DATE '1900-01-01'), coalesce(source_team_id,-1), coalesce(destination_team_id,-1)) DO NOTHING`,
      [r.providerTransferId, playerId, fromId, toId, r.transferDate, r.transferType, r.isLoan, r.fee, JSON.stringify(r)],
    );
    n++;
  }
  return n;
}

export async function storeOdds(data: OddsRowData): Promise<number> {
  const fixtureId = (
    await query<{ id: number }>(`SELECT id FROM fixtures WHERE provider='api-football' AND provider_id=$1`, [data.fixtureProviderId])
  ).rows[0]?.id;
  if (!fixtureId) return 0;
  let n = 0;
  for (const b of data.bookmakers) {
    const bookmakerId = (
      await query<{ id: number }>(
        `INSERT INTO bookmakers (provider, provider_id, name) VALUES ('api-football', $1, $2)
         ON CONFLICT (provider, provider_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now() RETURNING id`,
        [b.providerId, b.name],
      )
    ).rows[0].id;
    for (const m of b.markets) {
      const oddsId = (
        await query<{ id: number }>(
          `INSERT INTO odds (fixture_id, bookmaker_id, market, provider_updated_at)
           VALUES ($1,$2,$3,$4) RETURNING id
           ON CONFLICT (fixture_id, bookmaker_id, market) DO UPDATE SET
             provider_updated_at = COALESCE(EXCLUDED.provider_updated_at, odds.provider_updated_at), updated_at=now()
           RETURNING id`,
          [fixtureId, bookmakerId, m.name, data.providerUpdatedAt],
        )
      ).rows[0].id;
      for (const v of m.values) {
        await query(
          `INSERT INTO odds_values (odds_id, label, selection_name, odd_value)
           VALUES ($1,$2,$3,$4) ON CONFLICT (odds_id, label, selection_name) DO UPDATE SET odd_value = EXCLUDED.odd_value`,
          [oddsId, v.label, v.selectionName, v.odd],
        );
      }
    }
    n++;
  }
  return n;
}

export { nameKey, crypto };
