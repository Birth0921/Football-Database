/** Referee analytics — derived locally from stored fixtures/events/statistics. */
import { query, queryOne } from '../lib/db.js';

interface Agg {
  matches: number;
  home_wins: number;
  draws: number;
  away_wins: number;
  yellow: number;
  second_yellow: number;
  red: number;
  fouls: number;
  penalties: number;
  home_cards: number;
  away_cards: number;
}

function emptyAgg(): Agg {
  return { matches: 0, home_wins: 0, draws: 0, away_wins: 0, yellow: 0, second_yellow: 0, red: 0, fouls: 0, penalties: 0, home_cards: 0, away_cards: 0 };
}

function per(a: number, m: number): number {
  return m > 0 ? Math.round((a / m) * 100) / 100 : 0;
}

/** Per-fixture referee record (call after match completion). */
export async function recalculateRefereeForFixture(
  fixtureId: number,
  opts: { recalculateAggregates?: boolean } = {},
): Promise<{ refereeId: number | null; rows: number }> {
  const fx = await queryOne<{
    id: number; referee_id: number | null; competition_id: number | null; season_id: number | null;
    home_team_id: number | null; status_short: string;
  }>(`SELECT id, referee_id, competition_id, season_id, home_team_id, status_short FROM fixtures WHERE id = $1`, [fixtureId]);
  if (!fx || !fx.referee_id) return { refereeId: null, rows: 0 };
  if (!['FT', 'AET', 'PEN'].includes(fx.status_short)) return { refereeId: fx.referee_id, rows: 0 };

  const events = await query<{ event_type: string; event_detail: string | null; team_id: number | null; is_home: boolean | null }>(
    `SELECT event_type, event_detail, team_id, is_home FROM fixture_events WHERE fixture_id = $1`,
    [fixtureId],
  );

  let yellow = 0;
  let second = 0;
  let red = 0;
  let penalties = 0;
  let homeCards = 0;
  let awayCards = 0;
  for (const e of events) {
    const type = (e.event_type ?? '').toLowerCase();
    const detail = (e.event_detail ?? '').toLowerCase();
    const isHome = e.is_home ?? (e.team_id != null && e.team_id === fx.home_team_id);
    if (type === 'card') {
      if (detail.includes('second yellow')) {
        second += 1;
        homeCards += isHome ? 1 : 0;
        awayCards += isHome ? 0 : 1;
      } else if (detail.includes('red')) {
        red += 1;
        homeCards += isHome ? 1 : 0;
        awayCards += isHome ? 0 : 1;
      } else if (detail.includes('yellow')) {
        yellow += 1;
        homeCards += isHome ? 1 : 0;
        awayCards += isHome ? 0 : 1;
      }
    }
    if (type === 'goal' && (detail.includes('penalty') || detail.includes('missed penalty'))) penalties += 1;
    if (detail.includes('penalty')) penalties += type !== 'goal' ? 1 : 0;
  }
  // fouls come from team statistics
  const fouls = await queryOne<{ total: number | null }>(
    `SELECT sum(fouls) AS total FROM fixture_team_statistics WHERE fixture_id = $1`,
    [fixtureId],
  );

  await query(
    `INSERT INTO referee_match_statistics
       (referee_id, fixture_id, yellow_home, yellow_away, second_yellow, red_cards, fouls, penalties, matches)
     SELECT $1, $2,
            (SELECT count(*) FROM fixture_events WHERE fixture_id = $2 AND event_type = 'Card' AND coalesce(event_detail,'') LIKE '%Yellow%'
               AND coalesce(event_detail,'') NOT LIKE '%Second%' AND (is_home IS TRUE OR team_id = f.home_team_id))::int,
            (SELECT count(*) FROM fixture_events WHERE fixture_id = $2 AND event_type = 'Card' AND coalesce(event_detail,'') LIKE '%Yellow%'
               AND coalesce(event_detail,'') NOT LIKE '%Second%' AND (is_home IS FALSE OR team_id = f.away_team_id))::int,
            $3, $4, $5, $6, 1
       FROM fixtures f WHERE f.id = $2
     ON CONFLICT (referee_id, fixture_id) DO UPDATE SET
       yellow_home = EXCLUDED.yellow_home, yellow_away = EXCLUDED.yellow_away,
       second_yellow = EXCLUDED.second_yellow, red_cards = EXCLUDED.red_cards,
       fouls = EXCLUDED.fouls, penalties = EXCLUDED.penalties, calculated_at = now()`,
    [fx.referee_id, fixtureId, second, red, fouls?.total ?? null, penalties],
  );

  if (opts.recalculateAggregates !== false && fx.season_id && fx.competition_id) {
    await recalculateRefereeSeason(fx.referee_id, fx.season_id, fx.competition_id);
    await recalculateRefereeCompetition(fx.referee_id, fx.competition_id);
  }
  return { refereeId: fx.referee_id, rows: 1 };
}

export async function recalculateRefereeSeason(refereeId: number, seasonId: number, competitionId: number): Promise<Agg> {
  const rows = await query<{
    status_short: string; home_team_id: number | null; home_score: number | null; away_score: number | null;
    yellow_home: number | null; yellow_away: number | null; second_yellow: number | null;
    red_cards: number | null; fouls: number | null; penalties: number | null; kickoff_utc: Date | null;
  }>(
    `SELECT f.status_short, f.home_team_id, f.home_score, f.away_score,
            r.yellow_home, r.yellow_away, r.second_yellow, r.red_cards, r.fouls, r.penalties, f.kickoff_utc
       FROM referee_match_statistics r
       JOIN fixtures f ON f.id = r.fixture_id
      WHERE r.referee_id = $1 AND f.season_id = $2 AND f.competition_id = $3
        AND f.status_short IN ('FT','AET','PEN')
      ORDER BY f.kickoff_utc ASC`,
    [refereeId, seasonId, competitionId],
  );

  const agg = emptyAgg();
  for (const r of rows) {
    agg.matches += 1;
    if (r.home_score != null && r.away_score != null) {
      if (r.home_score > r.away_score) agg.home_wins += 1;
      else if (r.home_score < r.away_score) agg.away_wins += 1;
      else agg.draws += 1;
    }
    agg.yellow += (r.yellow_home ?? 0) + (r.yellow_away ?? 0);
    agg.second_yellow += r.second_yellow ?? 0;
    agg.red += r.red_cards ?? 0;
    agg.fouls += r.fouls ?? 0;
    agg.penalties += r.penalties ?? 0;
    agg.home_cards += (r.yellow_home ?? 0);
    agg.away_cards += (r.yellow_away ?? 0);
  }

  const last = (k: number) => rows.slice(-k).map((r) => ({
    fixtureRef: true,
    yellow: (r.yellow_home ?? 0) + (r.yellow_away ?? 0),
    red: r.red_cards ?? 0,
    date: r.kickoff_utc,
  }));

  await query(
    `INSERT INTO referee_season_statistics
       (referee_id, season_id, competition_id, matches, home_wins, draws, away_wins,
        yellow_cards, yellow_per_match, second_yellow, red_cards, red_per_match, total_cards, cards_per_match,
        fouls, fouls_per_match, penalties, penalties_per_match,
        home_cards, away_cards, home_cards_per_match, away_cards_per_match, last_5, last_10, last_20)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (referee_id, season_id, competition_id) DO UPDATE SET
       matches = EXCLUDED.matches, home_wins = EXCLUDED.home_wins, draws = EXCLUDED.draws, away_wins = EXCLUDED.away_wins,
       yellow_cards = EXCLUDED.yellow_cards, yellow_per_match = EXCLUDED.yellow_per_match,
       second_yellow = EXCLUDED.second_yellow, red_cards = EXCLUDED.red_cards, red_per_match = EXCLUDED.red_per_match,
       total_cards = EXCLUDED.total_cards, cards_per_match = EXCLUDED.cards_per_match,
       fouls = EXCLUDED.fouls, fouls_per_match = EXCLUDED.fouls_per_match,
       penalties = EXCLUDED.penalties, penalties_per_match = EXCLUDED.penalties_per_match,
       home_cards = EXCLUDED.home_cards, away_cards = EXCLUDED.away_cards,
       home_cards_per_match = EXCLUDED.home_cards_per_match, away_cards_per_match = EXCLUDED.away_cards_per_match,
       last_5 = EXCLUDED.last_5, last_10 = EXCLUDED.last_10, last_20 = EXCLUDED.last_20,
       calculated_at = now(), updated_at = now()`,
    [
      refereeId, seasonId, competitionId,
      agg.matches, agg.home_wins, agg.draws, agg.away_wins,
      agg.yellow, per(agg.yellow, agg.matches), agg.second_yellow, agg.red, per(agg.red, agg.matches),
      agg.yellow + agg.second_yellow + agg.red, per(agg.yellow + agg.second_yellow + agg.red, agg.matches),
      agg.fouls, per(agg.fouls, agg.matches), agg.penalties, per(agg.penalties, agg.matches),
      agg.home_cards, agg.away_cards, per(agg.home_cards, agg.matches), per(agg.away_cards, agg.matches),
      JSON.stringify(last(5)), JSON.stringify(last(10)), JSON.stringify(last(20)),
    ],
  );
  return agg;
}

export async function recalculateRefereeCompetition(refereeId: number, competitionId: number): Promise<void> {
  const agg = await queryOne<Agg & { matches: number }>(
    `SELECT
        count(*)::int AS matches,
        sum(CASE WHEN f.home_score > f.away_score THEN 1 ELSE 0 END)::int AS home_wins,
        sum(CASE WHEN f.home_score = f.away_score THEN 1 ELSE 0 END)::int AS draws,
        sum(CASE WHEN f.home_score < f.away_score THEN 1 ELSE 0 END)::int AS away_wins,
        coalesce(sum(coalesce(r.yellow_home,0) + coalesce(r.yellow_away,0)),0)::int AS yellow,
        coalesce(sum(r.second_yellow),0)::int AS second_yellow,
        coalesce(sum(r.red_cards),0)::int AS red,
        coalesce(sum(r.fouls),0)::int AS fouls,
        coalesce(sum(r.penalties),0)::int AS penalties,
        coalesce(sum(r.yellow_home),0)::int AS home_cards,
        coalesce(sum(r.yellow_away),0)::int AS away_cards
       FROM referee_match_statistics r
       JOIN fixtures f ON f.id = r.fixture_id
      WHERE r.referee_id = $1 AND f.competition_id = $2 AND f.status_short IN ('FT','AET','PEN')`,
    [refereeId, competitionId],
  );
  const a = agg ?? emptyAgg();
  const m = a.matches ?? 0;
  await query(
    `INSERT INTO referee_competition_statistics
       (referee_id, competition_id, matches, yellow_per_match, red_per_match, cards_per_match,
        fouls_per_match, penalties_per_match, home_cards_per_match, away_cards_per_match, aggregates)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (referee_id, competition_id) DO UPDATE SET
       matches = EXCLUDED.matches, yellow_per_match = EXCLUDED.yellow_per_match, red_per_match = EXCLUDED.red_per_match,
       cards_per_match = EXCLUDED.cards_per_match, fouls_per_match = EXCLUDED.fouls_per_match,
       penalties_per_match = EXCLUDED.penalties_per_match, home_cards_per_match = EXCLUDED.home_cards_per_match,
       away_cards_per_match = EXCLUDED.away_cards_per_match, aggregates = EXCLUDED.aggregates,
       calculated_at = now(), updated_at = now()`,
    [
      refereeId, competitionId, m,
      per(a.yellow, m), per(a.red, m), per(a.yellow + a.second_yellow + a.red, m),
      per(a.fouls, m), per(a.penalties, m), per(a.home_cards, m), per(a.away_cards, m),
      JSON.stringify(a),
    ],
  );
}

export async function recalculateAllReferees(): Promise<{ referees: number }> {
  // Bootstrap match-level analytics from completed fixtures, not from the
  // derived table itself. On a fresh/historical import referee_match_statistics
  // is empty, so using it as the seed makes the rebuild a permanent no-op.
  //
  // Bulk backfills only use fixtures with both event and team-stat detail:
  // cards come from fixture_events and fouls from fixture_team_statistics.
  // This avoids treating missing historical detail as genuine zero values.
  const fixtures = await query<{ id: number; referee_id: number }>(
    `SELECT f.id, f.referee_id
       FROM fixtures f
      WHERE f.referee_id IS NOT NULL
        AND f.status_short IN ('FT','AET','PEN')
        AND EXISTS (SELECT 1 FROM fixture_events e WHERE e.fixture_id = f.id)
        AND EXISTS (SELECT 1 FROM fixture_team_statistics s WHERE s.fixture_id = f.id)
      ORDER BY f.kickoff_utc ASC`,
  );

  const refereeIds = new Set<number>();
  for (const fixture of fixtures) {
    await recalculateRefereeForFixture(fixture.id, { recalculateAggregates: false });
    refereeIds.add(Number(fixture.referee_id));
  }

  // Match rows now exist; aggregate each referee/scope exactly once instead of
  // repeating the same season/competition scans after every fixture.
  for (const refereeId of refereeIds) {
    const pairs = await query<{ season_id: number; competition_id: number }>(
      `SELECT DISTINCT f.season_id, f.competition_id
         FROM referee_match_statistics rms
         JOIN fixtures f ON f.id = rms.fixture_id
        WHERE rms.referee_id = $1
          AND f.season_id IS NOT NULL
          AND f.competition_id IS NOT NULL`,
      [refereeId],
    );
    for (const pair of pairs) {
      await recalculateRefereeSeason(refereeId, pair.season_id, pair.competition_id);
    }

    const competitions = new Set(pairs.map((pair) => Number(pair.competition_id)));
    for (const competitionId of competitions) {
      await recalculateRefereeCompetition(refereeId, competitionId);
    }
  }

  return { referees: refereeIds.size };
}
