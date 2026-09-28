/** Player season statistics — derived locally from player_match_statistics. */
import { query, queryOne } from '../lib/db.js';

export async function recalculatePlayersForFixture(fixtureId: number): Promise<{ players: number }> {
  const fx = await queryOne<{ id: number; competition_id: number | null; season_id: number | null; status_short: string }>(
    `SELECT id, competition_id, season_id, status_short FROM fixtures WHERE id = $1`,
    [fixtureId],
  );
  if (!fx || !fx.competition_id || !fx.season_id) return { players: 0 };
  if (!['FT', 'AET', 'PEN'].includes(fx.status_short)) return { players: 0 };

  const players = await query<{ player_id: number; team_id: number | null }>(
    `SELECT DISTINCT player_id, team_id FROM player_match_statistics WHERE fixture_id = $1`,
    [fixtureId],
  );
  for (const p of players) {
    await recalculatePlayerSeason(p.player_id, p.team_id, fx.competition_id, fx.season_id);
  }
  return { players: players.length };
}

export async function recalculatePlayerSeason(playerId: number, teamId: number | null, competitionId: number, seasonId: number): Promise<void> {
  const a = await queryOne<Record<string, number | string | null>>(
    `SELECT
        count(*)::int AS appearances,
        count(*) FILTER (WHERE coalesce(pms.substitute, FALSE) = FALSE)::int AS lineups,
        coalesce(sum(pms.minutes), 0)::int AS minutes,
        coalesce(sum(pms.goals), 0)::int AS goals,
        coalesce(sum(pms.assists), 0)::int AS assists,
        coalesce(sum(pms.conceded_goals), 0)::int AS conceded_goals,
        coalesce(sum(pms.saves), 0)::int AS saves,
        coalesce(sum(pms.yellow_cards), 0)::int AS yellow_cards,
        coalesce(sum(pms.second_yellow), 0)::int AS second_yellow,
        coalesce(sum(pms.red_cards), 0)::int AS red_cards,
        coalesce(sum(pms.shots_total), 0)::int AS shots_total,
        coalesce(sum(pms.shots_on_target), 0)::int AS shots_on_target,
        coalesce(sum(pms.key_passes), 0)::int AS key_passes,
        coalesce(sum(pms.passes_total), 0)::int AS passes_total,
        coalesce(sum(pms.passes_accurate), 0)::int AS passes_accurate,
        coalesce(sum(pms.tackles), 0)::int AS tackles,
        coalesce(sum(pms.interceptions), 0)::int AS interceptions,
        coalesce(sum(pms.blocks), 0)::int AS blocks,
        coalesce(sum(pms.clearances), 0)::int AS clearances,
        coalesce(sum(pms.duels_total), 0)::int AS duels_total,
        coalesce(sum(pms.duels_won), 0)::int AS duels_won,
        coalesce(sum(pms.dribbles_attempts), 0)::int AS dribbles_attempts,
        coalesce(sum(pms.dribbles_success), 0)::int AS dribbles_success,
        coalesce(sum(pms.fouls_committed), 0)::int AS fouls_committed,
        coalesce(sum(pms.fouls_drawn), 0)::int AS fouls_drawn,
        coalesce(sum(pms.offsides), 0)::int AS offsides,
        coalesce(sum(pms.penalties_won), 0)::int AS penalties_won,
        coalesce(sum(pms.penalties_committed), 0)::int AS penalties_committed,
        coalesce(sum(pms.penalty_goals), 0)::int AS penalty_goals,
        coalesce(sum(pms.penalty_missed), 0)::int AS penalty_missed,
        count(*) FILTER (WHERE pms.clean_sheet IS TRUE OR (pms.conceded_goals = 0 AND pms.minutes >= 60))::int AS clean_sheets,
        sum(pms.expected_goals)::text AS expected_goals,
        sum(pms.expected_assists)::text AS expected_assists
       FROM player_match_statistics pms
       JOIN fixtures f ON f.id = pms.fixture_id
      WHERE pms.player_id = $1
        AND ($2::bigint IS NULL OR pms.team_id = $2)
        AND f.competition_id = $3 AND f.season_id = $4
        AND f.status_short IN ('FT','AET','PEN')`,
    [playerId, teamId, competitionId, seasonId],
  );
  if (!a) return;

  await query(
    `INSERT INTO player_season_statistics
       (player_id, team_id, competition_id, season_id, appearances, lineups, minutes, goals, assists,
        conceded_goals, saves, yellow_cards, second_yellow, red_cards, shots_total, shots_on_target,
        key_passes, passes_total, passes_accurate, tackles, interceptions, blocks, clearances,
        duels_total, duels_won, dribbles_attempts, dribbles_success, fouls_committed, fouls_drawn, offsides,
        penalties_won, penalties_committed, penalty_goals, penalty_missed, clean_sheets,
        expected_goals, expected_assists, is_local_derived, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
             $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37, TRUE, now())
     ON CONFLICT (player_id, team_id, competition_id, season_id) DO UPDATE SET
       appearances = EXCLUDED.appearances, lineups = EXCLUDED.lineups, minutes = EXCLUDED.minutes,
       goals = EXCLUDED.goals, assists = EXCLUDED.assists, conceded_goals = EXCLUDED.conceded_goals, saves = EXCLUDED.saves,
       yellow_cards = EXCLUDED.yellow_cards, second_yellow = EXCLUDED.second_yellow, red_cards = EXCLUDED.red_cards,
       shots_total = EXCLUDED.shots_total, shots_on_target = EXCLUDED.shots_on_target, key_passes = EXCLUDED.key_passes,
       passes_total = EXCLUDED.passes_total, passes_accurate = EXCLUDED.passes_accurate,
       tackles = EXCLUDED.tackles, interceptions = EXCLUDED.interceptions, blocks = EXCLUDED.blocks, clearances = EXCLUDED.clearances,
       duels_total = EXCLUDED.duels_total, duels_won = EXCLUDED.duels_won,
       dribbles_attempts = EXCLUDED.dribbles_attempts, dribbles_success = EXCLUDED.dribbles_success,
       fouls_committed = EXCLUDED.fouls_committed, fouls_drawn = EXCLUDED.fouls_drawn, offsides = EXCLUDED.offsides,
       penalties_won = EXCLUDED.penalties_won, penalties_committed = EXCLUDED.penalties_committed,
       penalty_goals = EXCLUDED.penalty_goals, penalty_missed = EXCLUDED.penalty_missed, clean_sheets = EXCLUDED.clean_sheets,
       expected_goals = EXCLUDED.expected_goals, expected_assists = EXCLUDED.expected_assists,
       is_local_derived = TRUE, calculated_at = now(), updated_at = now()`,
    [
      playerId, teamId, competitionId, seasonId,
      num(a.appearances), num(a.lineups), num(a.minutes), num(a.goals), num(a.assists),
      num(a.conceded_goals), num(a.saves), num(a.yellow_cards), num(a.second_yellow), num(a.red_cards),
      num(a.shots_total), num(a.shots_on_target), num(a.key_passes), num(a.passes_total), num(a.passes_accurate),
      num(a.tackles), num(a.interceptions), num(a.blocks), num(a.clearances),
      num(a.duels_total), num(a.duels_won), num(a.dribbles_attempts), num(a.dribbles_success),
      num(a.fouls_committed), num(a.fouls_drawn), num(a.offsides),
      num(a.penalties_won), num(a.penalties_committed), num(a.penalty_goals), num(a.penalty_missed),
      num(a.clean_sheets),
      a.expected_goals != null ? Number(a.expected_goals).toFixed(3) : null,
      a.expected_assists != null ? Number(a.expected_assists).toFixed(3) : null,
    ],
  );
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x) : null;
}

export async function recalculateAllPlayers(): Promise<{ players: number }> {
  const rows = await query<{ player_id: number; team_id: number | null; competition_id: number; season_id: number }>(
    `SELECT DISTINCT pms.player_id, pms.team_id, f.competition_id, f.season_id
       FROM player_match_statistics pms JOIN fixtures f ON f.id = pms.fixture_id
      WHERE f.competition_id IS NOT NULL AND f.season_id IS NOT NULL AND f.status_short IN ('FT','AET','PEN')`,
  );
  for (const r of rows) {
    await recalculatePlayerSeason(r.player_id, r.team_id, r.competition_id, r.season_id);
  }
  return { players: rows.length };
}
