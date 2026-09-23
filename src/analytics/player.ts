import { query } from '../db/pool.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'analytics-player' });

/**
 * Player season aggregates from local player_match_statistics.
 * Produces per-team rows and an aggregate row (team_id NULL) — a player
 * may play for multiple teams in one season (spec §17).
 */
export async function recalcPlayerSeasonStatistics(competitionSeasonId: number, playerId?: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `WITH pm AS (
       SELECT pms.*
       FROM player_match_statistics pms
       JOIN fixtures f ON f.id = pms.fixture_id
       WHERE f.competition_season_id = $1 AND f.is_finished
         ${playerId ? 'AND pms.player_id = $2' : ''}
     )
     INSERT INTO player_season_statistics (
       competition_season_id, player_id, team_id,
       appearances, starts, minutes, goals, assists, shots, shots_on_target, key_passes,
       passes, accurate_passes, pass_accuracy_pct, tackles, interceptions, clearances, blocks,
       duels, duels_won, dribbles_attempts, dribbles_success, fouls_committed, fouls_drawn, offsides,
       yellow_cards, second_yellow_cards, red_cards, penalties_won, penalties_committed,
       penalty_goals, penalty_misses, goalkeeper_saves, goals_conceded, clean_sheets,
       expected_goals, expected_assists, avg_rating, last_calculated_at)
     SELECT $1, player_id, team_id,
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE NOT is_substitute)::int,
       COALESCE(SUM(minutes_played),0)::int,
       COALESCE(SUM(goals),0)::int,
       COALESCE(SUM(assists),0)::int,
       COALESCE(SUM(shots_total),0)::int,
       COALESCE(SUM(shots_on_goal),0)::int,
       COALESCE(SUM(key_passes),0)::int,
       COALESCE(SUM(passes_total),0)::int,
       COALESCE(SUM(passes_accurate),0)::int,
       CASE WHEN SUM(passes_total) > 0 THEN ROUND(SUM(passes_accurate) * 100.0 / SUM(passes_total), 2) ELSE NULL END,
       COALESCE(SUM(tackles),0)::int,
       COALESCE(SUM(interceptions),0)::int,
       0,
       COALESCE(SUM(blocks),0)::int,
       COALESCE(SUM(duels_total),0)::int,
       COALESCE(SUM(duels_won),0)::int,
       COALESCE(SUM(dribbles_attempts),0)::int,
       COALESCE(SUM(dribbles_success),0)::int,
       COALESCE(SUM(fouls_committed),0)::int,
       COALESCE(SUM(fouls_drawn),0)::int,
       0,
       COALESCE(SUM(yellow_cards),0)::int,
       COALESCE(SUM(yellowred_cards),0)::int,
       COALESCE(SUM(red_cards),0)::int,
       COALESCE(SUM(penalty_won),0)::int,
       COALESCE(SUM(penalty_committed),0)::int,
       COALESCE(SUM(penalty_scored),0)::int,
       COALESCE(SUM(penalty_missed),0)::int,
       COALESCE(SUM(saves),0)::int,
       COALESCE(SUM(goals_conceded),0)::int,
       COUNT(*) FILTER (WHERE clean_sheet)::int,
       COALESCE(SUM(expected_goals),0),
       COALESCE(SUM(expected_assists),0),
       CASE WHEN COUNT(rating) > 0 THEN ROUND(AVG(rating), 2) ELSE NULL END,
       now()
     FROM pm GROUP BY player_id, team_id
     ON CONFLICT (competition_season_id, player_id, team_key) DO UPDATE SET
       appearances=EXCLUDED.appearances, starts=EXCLUDED.starts, minutes=EXCLUDED.minutes,
       goals=EXCLUDED.goals, assists=EXCLUDED.assists, shots=EXCLUDED.shots, shots_on_target=EXCLUDED.shots_on_target,
       key_passes=EXCLUDED.key_passes, passes=EXCLUDED.passes, accurate_passes=EXCLUDED.accurate_passes,
       pass_accuracy_pct=EXCLUDED.pass_accuracy_pct, tackles=EXCLUDED.tackles, interceptions=EXCLUDED.interceptions,
       clearances=EXCLUDED.clearances, blocks=EXCLUDED.blocks, duels=EXCLUDED.duels, duels_won=EXCLUDED.duels_won,
       dribbles_attempts=EXCLUDED.dribbles_attempts, dribbles_success=EXCLUDED.dribbles_success,
       fouls_committed=EXCLUDED.fouls_committed, fouls_drawn=EXCLUDED.fouls_drawn, offsides=EXCLUDED.offsides,
       yellow_cards=EXCLUDED.yellow_cards, second_yellow_cards=EXCLUDED.second_yellow_cards, red_cards=EXCLUDED.red_cards,
       penalties_won=EXCLUDED.penalties_won, penalties_committed=EXCLUDED.penalties_committed,
       penalty_goals=EXCLUDED.penalty_goals, penalty_misses=EXCLUDED.penalty_misses,
       goalkeeper_saves=EXCLUDED.goalkeeper_saves, goals_conceded=EXCLUDED.goals_conceded, clean_sheets=EXCLUDED.clean_sheets,
       expected_goals=EXCLUDED.expected_goals, expected_assists=EXCLUDED.expected_assists,
       avg_rating=EXCLUDED.avg_rating, last_calculated_at=now()`,
    playerId ? [competitionSeasonId, playerId] : [competitionSeasonId],
  );

  // aggregate rows across teams (team_id NULL) for players with >1 team that season
  await query(
    `WITH pm AS (
       SELECT pms.*
       FROM player_match_statistics pms
       JOIN fixtures f ON f.id = pms.fixture_id
       WHERE f.competition_season_id = $1 AND f.is_finished ${playerId ? 'AND pms.player_id = $2' : ''}
     ),
     per_player AS (
       SELECT player_id,
         COUNT(*)::int AS appearances,
         COUNT(*) FILTER (WHERE NOT is_substitute)::int AS starts,
         COALESCE(SUM(minutes_played),0)::int AS minutes,
         COALESCE(SUM(goals),0)::int AS goals,
         COALESCE(SUM(assists),0)::int AS assists,
         COALESCE(SUM(shots_total),0)::int AS shots,
         COALESCE(SUM(shots_on_goal),0)::int AS shots_on_target,
         COALESCE(SUM(key_passes),0)::int AS key_passes,
         COALESCE(SUM(passes_total),0)::int AS passes,
         COALESCE(SUM(passes_accurate),0)::int AS accurate_passes,
         COALESCE(SUM(tackles),0)::int AS tackles,
         COALESCE(SUM(interceptions),0)::int AS interceptions,
         COALESCE(SUM(blocks),0)::int AS blocks,
         COALESCE(SUM(duels_total),0)::int AS duels,
         COALESCE(SUM(duels_won),0)::int AS duels_won,
         COALESCE(SUM(dribbles_attempts),0)::int AS dribbles_attempts,
         COALESCE(SUM(dribbles_success),0)::int AS dribbles_success,
         COALESCE(SUM(fouls_committed),0)::int AS fouls_committed,
         COALESCE(SUM(fouls_drawn),0)::int AS fouls_drawn,
         COALESCE(SUM(yellow_cards),0)::int AS yellow_cards,
         COALESCE(SUM(yellowred_cards),0)::int AS second_yellow_cards,
         COALESCE(SUM(red_cards),0)::int AS red_cards,
         COALESCE(SUM(penalty_won),0)::int AS penalties_won,
         COALESCE(SUM(penalty_committed),0)::int AS penalties_committed,
         COALESCE(SUM(penalty_scored),0)::int AS penalty_goals,
         COALESCE(SUM(penalty_missed),0)::int AS penalty_misses,
         COALESCE(SUM(saves),0)::int AS goalkeeper_saves,
         COALESCE(SUM(goals_conceded),0)::int AS goals_conceded,
         COUNT(*) FILTER (WHERE clean_sheet)::int AS clean_sheets,
         COALESCE(SUM(expected_goals),0) AS expected_goals,
         COALESCE(SUM(expected_assists),0) AS expected_assists,
         CASE WHEN COUNT(rating) > 0 THEN ROUND(AVG(rating), 2) ELSE NULL END AS avg_rating,
         COUNT(DISTINCT team_id) AS teams
       FROM pm GROUP BY player_id HAVING COUNT(DISTINCT team_id) > 1
     )
     INSERT INTO player_season_statistics (
       competition_season_id, player_id, team_id, appearances, starts, minutes, goals, assists,
       shots, shots_on_target, key_passes, passes, accurate_passes, pass_accuracy_pct,
       tackles, interceptions, clearances, blocks, duels, duels_won, dribbles_attempts, dribbles_success,
       fouls_committed, fouls_drawn, offsides, yellow_cards, second_yellow_cards, red_cards,
       penalties_won, penalties_committed, penalty_goals, penalty_misses, goalkeeper_saves,
       goals_conceded, clean_sheets, expected_goals, expected_assists, avg_rating, last_calculated_at)
     SELECT $1, player_id, NULL, appearances, starts, minutes, goals, assists,
       shots, shots_on_target, key_passes, passes, accurate_passes,
       CASE WHEN passes > 0 THEN ROUND(accurate_passes * 100.0 / passes, 2) ELSE NULL END,
       tackles, interceptions, 0, blocks, duels, duels_won, dribbles_attempts, dribbles_success,
       fouls_committed, fouls_drawn, 0, yellow_cards, second_yellow_cards, red_cards,
       penalties_won, penalties_committed, penalty_goals, penalty_misses, goalkeeper_saves,
       goals_conceded, clean_sheets, expected_goals, expected_assists, avg_rating, now()
     FROM per_player
     ON CONFLICT (competition_season_id, player_id, team_key) DO UPDATE SET
       appearances=EXCLUDED.appearances, starts=EXCLUDED.starts, minutes=EXCLUDED.minutes,
       goals=EXCLUDED.goals, assists=EXCLUDED.assists, shots=EXCLUDED.shots, shots_on_target=EXCLUDED.shots_on_target,
       key_passes=EXCLUDED.key_passes, passes=EXCLUDED.passes, accurate_passes=EXCLUDED.accurate_passes,
       tackles=EXCLUDED.tackles, interceptions=EXCLUDED.interceptions, blocks=EXCLUDED.blocks,
       duels=EXCLUDED.duels, duels_won=EXCLUDED.duels_won, dribbles_attempts=EXCLUDED.dribbles_attempts,
       dribbles_success=EXCLUDED.dribbles_success, fouls_committed=EXCLUDED.fouls_committed, fouls_drawn=EXCLUDED.fouls_drawn,
       yellow_cards=EXCLUDED.yellow_cards, second_yellow_cards=EXCLUDED.second_yellow_cards, red_cards=EXCLUDED.red_cards,
       penalties_won=EXCLUDED.penalties_won, penalties_committed=EXCLUDED.penalties_committed,
       penalty_goals=EXCLUDED.penalty_goals, penalty_misses=EXCLUDED.penalty_misses,
       goalkeeper_saves=EXCLUDED.goalkeeper_saves, goals_conceded=EXCLUDED.goals_conceded, clean_sheets=EXCLUDED.clean_sheets,
       expected_goals=EXCLUDED.expected_goals, expected_assists=EXCLUDED.expected_assists, avg_rating=EXCLUDED.avg_rating,
       last_calculated_at=now()`,
    playerId ? [competitionSeasonId, playerId] : [competitionSeasonId],
  );

  const n = parseInt(rows[0]?.n ?? '0', 10);
  log.info({ competitionSeasonId, playerId, upserted: n }, 'player season statistics recalculated');
  return n;
}
