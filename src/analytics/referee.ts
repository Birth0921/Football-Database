import { query } from '../db/pool.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'analytics-referee' });

/**
 * Derive referee statistics locally from stored fixtures + events.
 * Provider never offers aggregate referee stats — we never request them.
 * Events and team statistics are aggregated in separate CTEs to avoid join fan-out.
 */
export async function recalcRefereeMatchStats(competitionSeasonId?: number): Promise<number> {
  const filter = competitionSeasonId ? `AND f.competition_season_id = $1` : '';
  const params = competitionSeasonId ? [competitionSeasonId] : [];
  const { rows } = await query<{ n: string }>(
    `WITH finished AS (
       SELECT f.* FROM fixtures f WHERE f.referee_id IS NOT NULL AND f.is_finished ${filter}
     ),
     ev AS (
       SELECT e.fixture_id,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'yellow%card%' AND e.event_detail NOT ILIKE 'second%')::int AS yellow_cards,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'second%')::int AS second_yellow_cards,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND e.event_detail ILIKE 'red card%')::int AS red_cards,
         COUNT(*) FILTER (WHERE (e.event_type='Goal' AND e.event_detail ILIKE '%penalty%') OR e.event_type='Missed Penalty')::int AS penalties,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND f.home_team_id = e.team_id)::int AS home_cards,
         COUNT(*) FILTER (WHERE e.event_type='Card' AND f.away_team_id = e.team_id)::int AS away_cards
       FROM fixture_events e
       JOIN finished f ON f.id = e.fixture_id
       GROUP BY e.fixture_id
     ),
     ts AS (
       SELECT ts.fixture_id,
         COALESCE(SUM(CASE WHEN ts.team_id = f.home_team_id THEN ts.fouls ELSE 0 END),0)::int AS home_fouls,
         COALESCE(SUM(CASE WHEN ts.team_id = f.away_team_id THEN ts.fouls ELSE 0 END),0)::int AS away_fouls,
         COALESCE(SUM(CASE WHEN ts.team_id = f.home_team_id THEN ts.corners ELSE 0 END),0)::int AS home_corners,
         COALESCE(SUM(CASE WHEN ts.team_id = f.away_team_id THEN ts.corners ELSE 0 END),0)::int AS away_corners
       FROM fixture_team_statistics ts
       JOIN finished f ON f.id = ts.fixture_id
       GROUP BY ts.fixture_id
     )
     INSERT INTO referee_match_statistics (
       referee_id, fixture_id, competition_id, competition_season_id, match_date,
       home_team_id, away_team_id, home_wins, draws, away_wins, home_goals, away_goals,
       yellow_cards, second_yellow_cards, red_cards, total_cards, home_team_cards, away_team_cards,
       fouls, penalties, corners, updated_at)
     SELECT f.referee_id, f.id, f.competition_id, f.competition_season_id, f.kickoff_date,
            f.home_team_id, f.away_team_id,
            f.winner_team_id = f.home_team_id, f.winner_team_id IS NULL, f.winner_team_id = f.away_team_id,
            f.home_score, f.away_score,
            COALESCE(ev.yellow_cards,0), COALESCE(ev.second_yellow_cards,0), COALESCE(ev.red_cards,0),
            COALESCE(ev.yellow_cards,0) + COALESCE(ev.second_yellow_cards,0) + COALESCE(ev.red_cards,0),
            COALESCE(ev.home_cards,0), COALESCE(ev.away_cards,0),
            COALESCE(ts.home_fouls,0) + COALESCE(ts.away_fouls,0),
            COALESCE(ev.penalties,0),
            COALESCE(ts.home_corners,0) + COALESCE(ts.away_corners,0),
            now()
     FROM finished f
     LEFT JOIN ev ON ev.fixture_id = f.id
     LEFT JOIN ts ON ts.fixture_id = f.id
     ON CONFLICT (fixture_id) DO UPDATE SET
       yellow_cards = EXCLUDED.yellow_cards, second_yellow_cards = EXCLUDED.second_yellow_cards,
       red_cards = EXCLUDED.red_cards, total_cards = EXCLUDED.total_cards,
       home_team_cards = EXCLUDED.home_team_cards, away_team_cards = EXCLUDED.away_team_cards,
       fouls = EXCLUDED.fouls, penalties = EXCLUDED.penalties, corners = EXCLUDED.corners,
       home_wins = EXCLUDED.home_wins, draws = EXCLUDED.draws, away_wins = EXCLUDED.away_wins,
       home_goals = EXCLUDED.home_goals, away_goals = EXCLUDED.away_goals,
       match_date = EXCLUDED.match_date, updated_at = now()`,
    params,
  );
  const n = parseInt(rows[0]?.n ?? '0', 10);
  log.info({ competitionSeasonId, upserted: n }, 'referee match stats recalculated');
  return n;
}

function windowJson(windowSize: number): string {
  return `
    (json_agg(json_build_object(
      'fixtureId', rms.fixture_id,
      'date', rms.match_date,
      'homeTeamId', rms.home_team_id,
      'awayTeamId', rms.away_team_id,
      'score', json_build_object('home', rms.home_goals, 'away', rms.away_goals),
      'yellowCards', rms.yellow_cards,
      'redCards', rms.red_cards,
      'totalCards', rms.total_cards,
      'penalties', rms.penalties
    ) ORDER BY rms.match_date DESC NULLS LAST, rms.fixture_id DESC)
    FILTER (WHERE rn <= ${windowSize}))::jsonb AS last${windowSize}`;
}

export async function recalcRefereeSeasonStats(competitionSeasonId?: number): Promise<number> {
  const filter = competitionSeasonId ? `WHERE rms.competition_season_id = $1` : '';
  const params = competitionSeasonId ? [competitionSeasonId] : [];
  const { rows } = await query<{ n: string }>(
    `WITH per_match AS (
      SELECT rms.*, ROW_NUMBER() OVER (PARTITION BY rms.referee_id, rms.competition_season_id ORDER BY rms.match_date DESC NULLS LAST, rms.fixture_id DESC) AS rn
      FROM referee_match_statistics rms
      ${filter}
    )
    INSERT INTO referee_season_statistics (
      referee_id, competition_season_id, matches, home_wins, draws, away_wins,
      yellow_cards, yellow_cards_per_match, second_yellow_cards, red_cards, red_cards_per_match,
      total_cards, cards_per_match, fouls, fouls_per_match, penalties, penalties_per_match,
      home_team_cards, away_team_cards, home_cards_per_match, away_cards_per_match, corners, goals,
      last5, last10, last20, last_calculated_at)
    SELECT rms.referee_id, rms.competition_season_id,
      COUNT(*)::int AS matches,
      COUNT(*) FILTER (WHERE home_wins)::int,
      COUNT(*) FILTER (WHERE draws)::int,
      COUNT(*) FILTER (WHERE away_wins)::int,
      SUM(yellow_cards)::int, ROUND(SUM(yellow_cards)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(second_yellow_cards)::int, SUM(red_cards)::int, ROUND(SUM(red_cards)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(total_cards)::int, ROUND(SUM(total_cards)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(fouls)::int, ROUND(SUM(fouls)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(penalties)::int, ROUND(SUM(penalties)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(home_team_cards)::int, SUM(away_team_cards)::int,
      ROUND(SUM(home_team_cards)::numeric / GREATEST(COUNT(*),1), 3),
      ROUND(SUM(away_team_cards)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(corners)::int, COALESCE(SUM(home_goals + away_goals),0)::int,
      ${windowJson(5)}, ${windowJson(10)}, ${windowJson(20)}, now()
    FROM per_match rms
    GROUP BY rms.referee_id, rms.competition_season_id
    ON CONFLICT (referee_id, competition_season_id) DO UPDATE SET
      matches=EXCLUDED.matches, home_wins=EXCLUDED.home_wins, draws=EXCLUDED.draws, away_wins=EXCLUDED.away_wins,
      yellow_cards=EXCLUDED.yellow_cards, yellow_cards_per_match=EXCLUDED.yellow_cards_per_match,
      second_yellow_cards=EXCLUDED.second_yellow_cards, red_cards=EXCLUDED.red_cards, red_cards_per_match=EXCLUDED.red_cards_per_match,
      total_cards=EXCLUDED.total_cards, cards_per_match=EXCLUDED.cards_per_match,
      fouls=EXCLUDED.fouls, fouls_per_match=EXCLUDED.fouls_per_match,
      penalties=EXCLUDED.penalties, penalties_per_match=EXCLUDED.penalties_per_match,
      home_team_cards=EXCLUDED.home_team_cards, away_team_cards=EXCLUDED.away_team_cards,
      home_cards_per_match=EXCLUDED.home_cards_per_match, away_cards_per_match=EXCLUDED.away_cards_per_match,
      corners=EXCLUDED.corners, goals=EXCLUDED.goals,
      last5=EXCLUDED.last5, last10=EXCLUDED.last10, last20=EXCLUDED.last20, last_calculated_at=now()`,
    params,
  );
  const n = parseInt(rows[0]?.n ?? '0', 10);
  log.info({ competitionSeasonId, upserted: n }, 'referee season stats recalculated');
  return n;
}

export async function recalcRefereeCompetitionStats(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `INSERT INTO referee_competition_statistics (
       referee_id, competition_id, matches, yellow_cards, red_cards, total_cards, cards_per_match,
       fouls, fouls_per_match, penalties, penalties_per_match, goals, last_calculated_at)
    SELECT rms.referee_id, rms.competition_id,
      COUNT(*)::int, SUM(rms.yellow_cards)::int, SUM(rms.red_cards)::int, SUM(rms.total_cards)::int,
      ROUND(SUM(rms.total_cards)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(rms.fouls)::int, ROUND(SUM(rms.fouls)::numeric / GREATEST(COUNT(*),1), 3),
      SUM(rms.penalties)::int, ROUND(SUM(rms.penalties)::numeric / GREATEST(COUNT(*),1), 3),
      COALESCE(SUM(rms.home_goals + rms.away_goals),0)::int, now()
    FROM referee_match_statistics rms
    WHERE rms.competition_id IS NOT NULL
    GROUP BY rms.referee_id, rms.competition_id
    ON CONFLICT (referee_id, competition_id) DO UPDATE SET
      matches=EXCLUDED.matches, yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards,
      total_cards=EXCLUDED.total_cards, cards_per_match=EXCLUDED.cards_per_match,
      fouls=EXCLUDED.fouls, fouls_per_match=EXCLUDED.fouls_per_match,
      penalties=EXCLUDED.penalties, penalties_per_match=EXCLUDED.penalties_per_match,
      goals=EXCLUDED.goals, last_calculated_at=now()`,
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}
