import { query } from '../db/pool.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'analytics-team' });

/**
 * Team + competition + season aggregates — all computed locally from stored fixtures.
 * Recalculated for every team that played in the season (or a single team when given).
 */
export async function recalcTeamStatistics(competitionSeasonId: number, teamId?: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `WITH cs AS (SELECT id FROM competition_seasons WHERE id = $1),
     team_side AS (
       SELECT f.id AS fixture_id, t.team_id,
              CASE WHEN f.home_team_id = t.team_id THEN 'home' ELSE 'away' END AS side,
              f.home_score, f.away_score, f.winner_team_id, f.is_finished, f.kickoff_at
       FROM fixtures f
       JOIN cs ON f.competition_season_id = cs.id
       JOIN LATERAL (SELECT f.home_team_id AS team_id UNION ALL SELECT f.away_team_id) t(team_id) ON TRUE
     ),
     teams_in_season AS (
       SELECT DISTINCT team_id FROM team_side ${teamId ? 'WHERE team_id = $2' : ''}
     ),
     per_team AS (
       SELECT ts.team_id,
         COUNT(*) FILTER (WHERE fx.is_finished)::int AS matches,
         COUNT(*) FILTER (WHERE fx.is_finished AND fx.winner_team_id = ts.team_id)::int AS wins,
         COUNT(*) FILTER (WHERE fx.is_finished AND fx.winner_team_id IS NULL)::int AS draws,
         COUNT(*) FILTER (WHERE fx.is_finished AND fx.winner_team_id IS NOT NULL AND fx.winner_team_id <> ts.team_id)::int AS losses,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='home')::int AS home_matches,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='home' AND fx.winner_team_id = ts.team_id)::int AS home_wins,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='home' AND fx.winner_team_id IS NULL)::int AS home_draws,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='home' AND fx.winner_team_id <> ts.team_id AND fx.winner_team_id IS NOT NULL)::int AS home_losses,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='away')::int AS away_matches,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='away' AND fx.winner_team_id = ts.team_id)::int AS away_wins,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='away' AND fx.winner_team_id IS NULL)::int AS away_draws,
         COUNT(*) FILTER (WHERE fx.is_finished AND ts.side='away' AND fx.winner_team_id <> ts.team_id AND fx.winner_team_id IS NOT NULL)::int AS away_losses,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN fx.home_score ELSE fx.away_score END) FILTER (WHERE fx.is_finished),0)::int AS goals_for,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN fx.away_score ELSE fx.home_score END) FILTER (WHERE fx.is_finished),0)::int AS goals_against,
         COUNT(*) FILTER (WHERE fx.is_finished AND CASE WHEN ts.side='home' THEN fx.away_score ELSE fx.home_score END = 0)::int AS clean_sheets,
         COUNT(*) FILTER (WHERE fx.is_finished AND CASE WHEN ts.side='home' THEN fx.home_score ELSE fx.away_score END = 0)::int AS failed_to_score,
         COUNT(*) FILTER (WHERE fx.is_finished AND fx.home_score > 0 AND fx.away_score > 0)::int AS btts
       FROM team_side ts
       JOIN fixtures fx ON fx.id = ts.fixture_id
       JOIN teams_in_season tis ON tis.team_id = ts.team_id
       WHERE fx.is_finished
       GROUP BY ts.team_id
     ),
     team_events AS (
       SELECT ts.team_id,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'yellow%card%' AND e.event_detail NOT ILIKE 'second%')::int AS yellow_cards,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'second%')::int AS second_yellows,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'red card%')::int AS red_cards
       FROM team_side ts
       JOIN fixtures fx ON fx.id = ts.fixture_id AND fx.is_finished
       JOIN teams_in_season tis ON tis.team_id = ts.team_id
       JOIN fixture_events e ON e.fixture_id = fx.id AND e.team_id = ts.team_id
       GROUP BY ts.team_id
     ),
     per_fixture AS (
       SELECT fx.id,
         MAX(dts.fouls) FILTER (WHERE dts.team_id = fx.home_team_id) AS home_fouls,
         MAX(dts.fouls) FILTER (WHERE dts.team_id = fx.away_team_id) AS away_fouls,
         MAX(dts.corners) FILTER (WHERE dts.team_id = fx.home_team_id) AS home_corners,
         MAX(dts.corners) FILTER (WHERE dts.team_id = fx.away_team_id) AS away_corners,
         MAX(dts.shots_total) FILTER (WHERE dts.team_id = fx.home_team_id) AS home_shots,
         MAX(dts.shots_total) FILTER (WHERE dts.team_id = fx.away_team_id) AS away_shots,
         MAX(dts.shots_on_goal) FILTER (WHERE dts.team_id = fx.home_team_id) AS home_sot,
         MAX(dts.shots_on_goal) FILTER (WHERE dts.team_id = fx.away_team_id) AS away_sot,
         MAX(dts.possession_pct) FILTER (WHERE dts.team_id = fx.home_team_id) AS home_poss,
         MAX(dts.expected_goals) FILTER (WHERE dts.team_id = fx.home_team_id) AS home_xg,
         MAX(dts.expected_goals) FILTER (WHERE dts.team_id = fx.away_team_id) AS away_xg
       FROM fixtures fx
       JOIN fixture_team_statistics dts ON dts.fixture_id = fx.id
       WHERE fx.competition_season_id = $1 AND fx.is_finished
       GROUP BY fx.id
     ),
     deep AS (
       SELECT ts.team_id,
         COUNT(*)::int AS n_matches,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN pf.home_fouls ELSE pf.away_fouls END),0)::int AS fouls,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN pf.home_corners ELSE pf.away_corners END),0)::int AS corners,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN pf.home_shots ELSE pf.away_shots END),0)::int AS shots,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN pf.home_sot ELSE pf.away_sot END),0)::int AS shots_on_target,
         ROUND(AVG(CASE WHEN ts.side='home' THEN pf.home_poss END),2) AS possession_avg,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN pf.home_xg ELSE pf.away_xg END),0) AS xg,
         COALESCE(SUM(CASE WHEN ts.side='home' THEN pf.away_xg ELSE pf.home_xg END),0) AS xga
       FROM team_side ts
       JOIN fixtures fx ON fx.id = ts.fixture_id AND fx.is_finished
       JOIN per_fixture pf ON pf.id = fx.id
       JOIN teams_in_season tis ON tis.team_id = ts.team_id
       GROUP BY ts.team_id
     ),
     form AS (
       SELECT team_id,
         string_agg(res, '' ORDER BY rn) FILTER (WHERE rn <= 5) AS form_last5,
         string_agg(res, '' ORDER BY rn) FILTER (WHERE rn <= 10) AS form_last10,
         string_agg(res, '' ORDER BY rn) FILTER (WHERE rn <= 20) AS form_last20,
         string_agg(res, '' ORDER BY rn) FILTER (WHERE side='home' AND rn <= 10) AS home_form_last10,
         string_agg(res, '' ORDER BY rn) FILTER (WHERE side='away' AND rn <= 10) AS away_form_last10
       FROM (
         SELECT ts.team_id, ts.side,
           CASE WHEN fx.winner_team_id = ts.team_id THEN 'W' WHEN fx.winner_team_id IS NULL THEN 'D' ELSE 'L' END AS res,
           ROW_NUMBER() OVER (PARTITION BY ts.team_id ORDER BY fx.kickoff_at DESC) AS rn
         FROM team_side ts
         JOIN fixtures fx ON fx.id = ts.fixture_id AND fx.is_finished
       ) ranked
       GROUP BY team_id
     )
     INSERT INTO team_statistics (
       competition_season_id, team_id, matches, wins, draws, losses,
       home_matches, home_wins, home_draws, home_losses, away_matches, away_wins, away_draws, away_losses,
       goals_for, goals_against, goal_difference, avg_goals_scored, avg_goals_conceded,
       clean_sheets, failed_to_score, btts, btts_pct, yellow_cards, red_cards, total_cards,
       fouls, fouls_per_match, corners, corners_per_match, shots, shots_per_match,
       shots_on_target, shots_on_target_per_match, possession_avg, expected_goals, expected_goals_against,
       form_last5, form_last10, form_last20, home_form_last10, away_form_last10, streaks, last_calculated_at)
     SELECT $1, pt.team_id, pt.matches, pt.wins, pt.draws, pt.losses,
       pt.home_matches, pt.home_wins, pt.home_draws, pt.home_losses,
       pt.away_matches, pt.away_wins, pt.away_draws, pt.away_losses,
       pt.goals_for, pt.goals_against, pt.goals_for - pt.goals_against,
       ROUND(pt.goals_for::numeric / GREATEST(pt.matches,1), 3),
       ROUND(pt.goals_against::numeric / GREATEST(pt.matches,1), 3),
       pt.clean_sheets, pt.failed_to_score, pt.btts,
       ROUND(pt.btts * 100.0 / GREATEST(pt.matches,1), 2),
       COALESCE(te.yellow_cards,0), COALESCE(te.red_cards,0) + COALESCE(te.second_yellows,0),
       COALESCE(te.yellow_cards,0) + COALESCE(te.red_cards,0) + COALESCE(te.second_yellows,0),
       COALESCE(d.fouls,0), ROUND(COALESCE(d.fouls,0)::numeric / GREATEST(d.n_matches,1), 3),
       COALESCE(d.corners,0), ROUND(COALESCE(d.corners,0)::numeric / GREATEST(d.n_matches,1), 3),
       COALESCE(d.shots,0), ROUND(COALESCE(d.shots,0)::numeric / GREATEST(d.n_matches,1), 3),
       COALESCE(d.shots_on_target,0), ROUND(COALESCE(d.shots_on_target,0)::numeric / GREATEST(d.n_matches,1), 3),
       d.possession_avg, d.xg, d.xga,
       fm.form_last5, fm.form_last10, fm.form_last20, fm.home_form_last10, fm.away_form_last10,
       NULL::jsonb, now()
     FROM per_team pt
     LEFT JOIN team_events te ON te.team_id = pt.team_id
     LEFT JOIN deep d ON d.team_id = pt.team_id
     LEFT JOIN form fm ON fm.team_id = pt.team_id
     ON CONFLICT (competition_season_id, team_id) DO UPDATE SET
       matches=EXCLUDED.matches, wins=EXCLUDED.wins, draws=EXCLUDED.draws, losses=EXCLUDED.losses,
       home_matches=EXCLUDED.home_matches, home_wins=EXCLUDED.home_wins, home_draws=EXCLUDED.home_draws, home_losses=EXCLUDED.home_losses,
       away_matches=EXCLUDED.away_matches, away_wins=EXCLUDED.away_wins, away_draws=EXCLUDED.away_draws, away_losses=EXCLUDED.away_losses,
       goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against, goal_difference=EXCLUDED.goal_difference,
       avg_goals_scored=EXCLUDED.avg_goals_scored, avg_goals_conceded=EXCLUDED.avg_goals_conceded,
       clean_sheets=EXCLUDED.clean_sheets, failed_to_score=EXCLUDED.failed_to_score, btts=EXCLUDED.btts, btts_pct=EXCLUDED.btts_pct,
       yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards, total_cards=EXCLUDED.total_cards,
       fouls=EXCLUDED.fouls, fouls_per_match=EXCLUDED.fouls_per_match,
       corners=EXCLUDED.corners, corners_per_match=EXCLUDED.corners_per_match,
       shots=EXCLUDED.shots, shots_per_match=EXCLUDED.shots_per_match,
       shots_on_target=EXCLUDED.shots_on_target, shots_on_target_per_match=EXCLUDED.shots_on_target_per_match,
       possession_avg=EXCLUDED.possession_avg, expected_goals=EXCLUDED.expected_goals, expected_goals_against=EXCLUDED.expected_goals_against,
       form_last5=EXCLUDED.form_last5, form_last10=EXCLUDED.form_last10, form_last20=EXCLUDED.form_last20,
       home_form_last10=EXCLUDED.home_form_last10, away_form_last10=EXCLUDED.away_form_last10,
       last_calculated_at=now()`,
    teamId ? [competitionSeasonId, teamId] : [competitionSeasonId],
  );
  const n = parseInt(rows[0]?.n ?? '0', 10);
  log.info({ competitionSeasonId, teamId, upserted: n }, 'team statistics recalculated');
  return n;
}

/** Compute streak JSON separately and merge into team_statistics.streaks. */
export async function updateStreaks(competitionSeasonId: number): Promise<void> {
  await query(
    `WITH recent AS (
       SELECT ts.team_id,
         CASE WHEN f.winner_team_id = ts.team_id THEN 'W' WHEN f.winner_team_id IS NULL THEN 'D' ELSE 'L' END AS res,
         ROW_NUMBER() OVER (PARTITION BY ts.team_id ORDER BY f.kickoff_at DESC) AS rn
       FROM fixtures f
       JOIN LATERAL (SELECT f.home_team_id AS team_id UNION ALL SELECT f.away_team_id) ts(team_id) ON TRUE
       WHERE f.competition_season_id = $1 AND f.is_finished
     ),
     agg AS (
       SELECT team_id,
         array_agg(res ORDER BY rn) FILTER (WHERE rn <= 30) AS results
       FROM recent GROUP BY team_id
     )
     UPDATE team_statistics ts2 SET streaks = sub.j
     FROM (
       SELECT team_id, jsonb_build_object(
         'current', CASE WHEN results IS NULL THEN NULL
                    ELSE jsonb_build_object('result', results[1], 'count',
                      (SELECT count(*) FROM unnest(results) r WHERE r = results[1])) END,
         'unbeaten', (SELECT count(*) FROM unnest(results) WITH ORDINALITY u(r, i) WHERE i <= COALESCE(array_position(results, 'L'), array_length(results,1) + 1) - 1),
         'winless', (SELECT count(*) FROM unnest(results) WITH ORDINALITY u(r, i) WHERE i <= COALESCE(array_position(results, 'W'), array_length(results,1) + 1) - 1)
       )::jsonb AS j
       FROM agg
     ) sub
     WHERE ts2.competition_season_id = $1 AND ts2.team_id = sub.team_id`,
    [competitionSeasonId],
  );
}
