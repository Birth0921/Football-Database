import { query } from '../db/pool.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'analytics-league' });

/**
 * League/competition season aggregates — computed entirely from local data.
 * Pass 1: results/goals/cards/penalties from fixtures + events (all matches).
 * Pass 2: deep stats (fouls/corners/shots/possession/xG) over matches having team statistics.
 */
export async function recalcLeagueStatistics(competitionSeasonId: number): Promise<boolean> {
  const { rowCount } = await query(
    `WITH finished AS (
       SELECT f.* FROM fixtures f WHERE f.competition_season_id = $1 AND f.is_finished
     ),
     agg AS (
       SELECT
         COUNT(*)::int AS matches,
         COUNT(*) FILTER (WHERE f.is_finished)::int AS completed_matches,
         (COALESCE(SUM(f.home_score),0) + COALESCE(SUM(f.away_score),0))::int AS goals,
         COALESCE(SUM(f.home_score),0)::int AS home_goals,
         COALESCE(SUM(f.away_score),0)::int AS away_goals,
         COUNT(*) FILTER (WHERE f.winner_team_id = f.home_team_id)::int AS home_wins,
         COUNT(*) FILTER (WHERE f.winner_team_id IS NULL)::int AS draws,
         COUNT(*) FILTER (WHERE f.winner_team_id = f.away_team_id)::int AS away_wins,
         COUNT(*) FILTER (WHERE f.home_score > 0 AND f.away_score > 0)::int AS btts_count,
         (COUNT(*) FILTER (WHERE f.home_score = 0) + COUNT(*) FILTER (WHERE f.away_score = 0))::int AS clean_sheet_count,
         (COUNT(*) FILTER (WHERE f.home_score = 0) + COUNT(*) FILTER (WHERE f.away_score = 0))::int AS failed_to_score_count
       FROM finished f
     ),
     ev AS (
       SELECT
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'yellow%card%' AND e.event_detail NOT ILIKE 'second%')::int AS yellow_cards,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'second%')::int AS second_yellow_cards,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'red card%')::int AS red_cards,
         COUNT(*) FILTER (WHERE (e.event_type='Goal' AND e.event_detail ILIKE '%penalty%') OR e.event_type='Missed Penalty')::int AS penalties
       FROM fixture_events e
       JOIN finished f ON f.id = e.fixture_id
     )
     INSERT INTO league_statistics (
       competition_season_id, matches, completed_matches, goals, goals_per_match, home_goals, away_goals,
       home_wins, draws, away_wins, home_win_pct, draw_pct, away_win_pct,
       btts_count, btts_pct, clean_sheet_count, clean_sheet_pct, failed_to_score_count, failed_to_score_pct,
       yellow_cards, yellow_cards_per_match, second_yellow_cards, red_cards, red_cards_per_match,
       total_cards, cards_per_match, penalties, penalties_per_match, last_calculated_at)
     SELECT $1,
       agg.matches, agg.completed_matches, agg.goals,
       ROUND(agg.goals::numeric / GREATEST(agg.completed_matches,1), 3),
       agg.home_goals, agg.away_goals, agg.home_wins, agg.draws, agg.away_wins,
       ROUND(agg.home_wins * 100.0 / GREATEST(agg.completed_matches,1), 2),
       ROUND(agg.draws * 100.0 / GREATEST(agg.completed_matches,1), 2),
       ROUND(agg.away_wins * 100.0 / GREATEST(agg.completed_matches,1), 2),
       agg.btts_count, ROUND(agg.btts_count * 100.0 / GREATEST(agg.completed_matches,1), 2),
       agg.clean_sheet_count, ROUND(agg.clean_sheet_count * 100.0 / GREATEST(agg.completed_matches,1), 2),
       agg.failed_to_score_count, ROUND(agg.failed_to_score_count * 100.0 / GREATEST(agg.completed_matches,1), 2),
       ev.yellow_cards, ROUND(ev.yellow_cards::numeric / GREATEST(agg.completed_matches,1), 3),
       ev.second_yellow_cards, ev.red_cards, ROUND(ev.red_cards::numeric / GREATEST(agg.completed_matches,1), 3),
       ev.yellow_cards + ev.second_yellow_cards + ev.red_cards,
       ROUND((ev.yellow_cards + ev.second_yellow_cards + ev.red_cards)::numeric / GREATEST(agg.completed_matches,1), 3),
       ev.penalties, ROUND(ev.penalties::numeric / GREATEST(agg.completed_matches,1), 3),
       now()
     FROM agg, ev
     ON CONFLICT (competition_season_id) DO UPDATE SET
       matches=EXCLUDED.matches, completed_matches=EXCLUDED.completed_matches, goals=EXCLUDED.goals,
       goals_per_match=EXCLUDED.goals_per_match, home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals,
       home_wins=EXCLUDED.home_wins, draws=EXCLUDED.draws, away_wins=EXCLUDED.away_wins,
       home_win_pct=EXCLUDED.home_win_pct, draw_pct=EXCLUDED.draw_pct, away_win_pct=EXCLUDED.away_win_pct,
       btts_count=EXCLUDED.btts_count, btts_pct=EXCLUDED.btts_pct,
       clean_sheet_count=EXCLUDED.clean_sheet_count, clean_sheet_pct=EXCLUDED.clean_sheet_pct,
       failed_to_score_count=EXCLUDED.failed_to_score_count, failed_to_score_pct=EXCLUDED.failed_to_score_pct,
       yellow_cards=EXCLUDED.yellow_cards, yellow_cards_per_match=EXCLUDED.yellow_cards_per_match,
       second_yellow_cards=EXCLUDED.second_yellow_cards, red_cards=EXCLUDED.red_cards, red_cards_per_match=EXCLUDED.red_cards_per_match,
       total_cards=EXCLUDED.total_cards, cards_per_match=EXCLUDED.cards_per_match,
       penalties=EXCLUDED.penalties, penalties_per_match=EXCLUDED.penalties_per_match,
       last_calculated_at=now()`,
    [competitionSeasonId],
  );

  if (!rowCount) {
    log.warn({ competitionSeasonId }, 'league statistics: no competition_season matched');
    return false;
  }

  // pass 2: deep stats over matches that have team statistics
  await query(
    `WITH deep AS (
       SELECT DISTINCT f.id
       FROM fixtures f
       JOIN fixture_team_statistics ts ON ts.fixture_id = f.id
       WHERE f.competition_season_id = $1 AND f.is_finished
     ),
     stats AS (
       SELECT COUNT(DISTINCT f.id)::int AS n,
         COALESCE(SUM(ts.fouls),0)::int AS fouls,
         COALESCE(SUM(ts.corners),0)::int AS corners,
         COALESCE(SUM(ts.shots_total),0)::int AS shots,
         COALESCE(SUM(ts.shots_on_goal),0)::int AS shots_on_target,
         ROUND(AVG(ts.possession_pct), 2) AS possession_avg,
         COALESCE(SUM(ts.expected_goals),0) AS xg
       FROM deep d
       JOIN fixtures f ON f.id = d.id
       JOIN fixture_team_statistics ts ON ts.fixture_id = f.id
     ),
     ev AS (
       SELECT
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'yellow%card%' AND e.event_detail NOT ILIKE 'second%')::int AS yc,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'second%')::int AS syc,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'red card%')::int AS rc,
         COUNT(*) FILTER (WHERE (e.event_type='Goal' AND e.event_detail ILIKE '%penalty%') OR e.event_type='Missed Penalty')::int AS pens
       FROM deep d
       JOIN fixture_events e ON e.fixture_id = d.id
     ),
     s AS (SELECT stats.*, ev.yc, ev.syc, ev.rc, ev.pens FROM stats, ev)
     UPDATE league_statistics ls SET
       fouls = s.fouls, fouls_per_match = ROUND(s.fouls::numeric / GREATEST(s.n,1), 3),
       penalties = s.pens, penalties_per_match = ROUND(s.pens::numeric / GREATEST(s.n,1), 3),
       corners = s.corners, corners_per_match = ROUND(s.corners::numeric / GREATEST(s.n,1), 3),
       shots = s.shots, shots_per_match = ROUND(s.shots::numeric / GREATEST(s.n,1), 3),
       shots_on_target = s.shots_on_target, shots_on_target_per_match = ROUND(s.shots_on_target::numeric / GREATEST(s.n,1), 3),
       possession_avg = s.possession_avg,
       expected_goals = s.xg, expected_goals_per_match = ROUND(s.xg::numeric / GREATEST(s.n,1), 3),
       last_calculated_at = now()
     FROM s
     WHERE ls.competition_season_id = $1`,
    [competitionSeasonId],
  );

  log.info({ competitionSeasonId }, 'league statistics recalculated');
  return true;
}
