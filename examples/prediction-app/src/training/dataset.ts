/**
 * Training data extraction — the ONLY part of this app that touches
 * PostgreSQL, and it uses the read-only role created by migration
 * `0008_prediction_readonly_role.sql`.
 *
 * Two different exports:
 *
 * 1. `fetchMatches()` — completed results used to fit the Poisson team-strength
 *    model. Parameters are fitted on a chronological train split and scored on a
 *    later test split, so nothing from the future leaks into the evaluation.
 *
 * 2. `fetchPointInTimeDataset()` — one row per completed match with rolling
 *    pre-match features computed **strictly before kickoff** (SQL `LATERAL`
 *    over previous matches only). Use this to train your own ML model.
 *
 * ⚠️ Never train on `prediction_features` rows of finished matches: those are
 * computed from the current database state and therefore include the match
 * itself — every model trained on them looks amazing and performs terribly.
 */
import pg from 'pg';

export interface TrainingMatch {
  fixtureId: number;
  competitionId: number;
  seasonId: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffUtc: Date;
  homeGoals: number;
  awayGoals: number;
}

export interface PointInTimeRow {
  fixture_id: number;
  competition_id: number;
  season_id: number;
  kickoff_utc: string;
  home_team_id: number;
  away_team_id: number;
  home_goals: number;
  away_goals: number;
  home_goals_for_avg: number | null;
  home_goals_against_avg: number | null;
  away_goals_for_avg: number | null;
  away_goals_against_avg: number | null;
  home_prev_matches: number;
  away_prev_matches: number;
  result: 'H' | 'D' | 'A';
  total_goals: number;
  btts: 0 | 1;
}

export interface TeamRef {
  id: number;
  name: string;
}

const COMPLETED = `status_short IN ('FT','AET','PEN') AND home_score IS NOT NULL AND away_score IS NOT NULL`;

export async function fetchMatches(client: pg.Client | pg.Pool, options: { competitionIds?: number[] } = {}): Promise<TrainingMatch[]> {
  const params: unknown[] = [];
  let where = `WHERE f.${COMPLETED}`;
  if (options.competitionIds?.length) {
    params.push(options.competitionIds);
    where += ` AND f.competition_id = ANY($${params.length}::bigint[])`;
  }
  const { rows } = await client.query(
    `SELECT f.id, f.competition_id, f.season_id, f.home_team_id, f.away_team_id,
            f.kickoff_utc, f.home_score, f.away_score
       FROM fixtures f
       ${where}
        AND f.home_team_id IS NOT NULL AND f.away_team_id IS NOT NULL
      ORDER BY f.kickoff_utc ASC`,
    params,
  );
  return rows.map((r) => ({
    fixtureId: Number(r.id),
    competitionId: Number(r.competition_id),
    seasonId: Number(r.season_id),
    homeTeamId: Number(r.home_team_id),
    awayTeamId: Number(r.away_team_id),
    kickoffUtc: new Date(r.kickoff_utc),
    homeGoals: Number(r.home_score),
    awayGoals: Number(r.away_score),
  }));
}

export async function fetchTeams(client: pg.Client | pg.Pool): Promise<Map<number, string>> {
  const { rows } = await client.query(`SELECT id, name FROM teams`);
  return new Map(rows.map((r) => [Number(r.id), String(r.name)]));
}

export async function fetchCompetitions(client: pg.Client | pg.Pool): Promise<Map<number, string>> {
  const { rows } = await client.query(`SELECT id, name FROM competitions`);
  return new Map(rows.map((r) => [Number(r.id), String(r.name)]));
}

/**
 * Point-in-time rolling features: for every completed match, each team's
 * average goals scored/conceded over its previous `formMatches` matches in the
 * same competition, using only matches that kicked off earlier.
 */
export async function fetchPointInTimeDataset(
  client: pg.Client | pg.Pool,
  options: { formMatches?: number; competitionIds?: number[] } = {},
): Promise<PointInTimeRow[]> {
  const formMatches = Math.max(1, options.formMatches ?? 10);
  const params: unknown[] = [formMatches, formMatches];
  let where = '';
  if (options.competitionIds?.length) {
    params.push(options.competitionIds);
    where = `AND f.competition_id = ANY($${params.length}::bigint[])`;
  }
  const { rows } = await client.query(
    `SELECT f.id AS fixture_id,
            f.competition_id,
            f.season_id,
            f.kickoff_utc,
            f.home_team_id,
            f.away_team_id,
            f.home_score AS home_goals,
            f.away_score AS away_goals,
            hf.goals_for   AS home_goals_for_avg,
            hf.goals_against AS home_goals_against_avg,
            hf.n           AS home_prev_matches,
            af.goals_for   AS away_goals_for_avg,
            af.goals_against AS away_goals_against_avg,
            af.n           AS away_prev_matches,
            CASE WHEN f.home_score > f.away_score THEN 'H'
                 WHEN f.home_score < f.away_score THEN 'A' ELSE 'D' END AS result,
            (f.home_score + f.away_score) AS total_goals,
            CASE WHEN f.home_score > 0 AND f.away_score > 0 THEN 1 ELSE 0 END AS btts
       FROM fixtures f
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS n,
                round(avg(CASE WHEN p.home_team_id = f.home_team_id THEN p.home_score ELSE p.away_score END)::numeric, 3)::float8 AS goals_for,
                round(avg(CASE WHEN p.home_team_id = f.home_team_id THEN p.away_score ELSE p.home_score END)::numeric, 3)::float8 AS goals_against
           FROM (
             SELECT p.home_team_id, p.away_team_id, p.home_score, p.away_score
               FROM fixtures p
              WHERE (p.home_team_id = f.home_team_id OR p.away_team_id = f.home_team_id)
                AND p.competition_id = f.competition_id
                AND p.${COMPLETED}
                AND p.kickoff_utc < f.kickoff_utc
              ORDER BY p.kickoff_utc DESC
              LIMIT $1
           ) p
       ) hf
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS n,
                round(avg(CASE WHEN p.home_team_id = f.away_team_id THEN p.home_score ELSE p.away_score END)::numeric, 3)::float8 AS goals_for,
                round(avg(CASE WHEN p.home_team_id = f.away_team_id THEN p.away_score ELSE p.home_score END)::numeric, 3)::float8 AS goals_against
           FROM (
             SELECT p.home_team_id, p.away_team_id, p.home_score, p.away_score
               FROM fixtures p
              WHERE (p.home_team_id = f.away_team_id OR p.away_team_id = f.away_team_id)
                AND p.competition_id = f.competition_id
                AND p.${COMPLETED}
                AND p.kickoff_utc < f.kickoff_utc
              ORDER BY p.kickoff_utc DESC
              LIMIT $2
           ) p
       ) af
      WHERE f.${COMPLETED}
        AND f.home_team_id IS NOT NULL AND f.away_team_id IS NOT NULL
        ${where}
      ORDER BY f.kickoff_utc ASC`,
    params,
  );
  return rows as PointInTimeRow[];
}

/**
 * Fail loudly if the connection can write — training must never be able to
 * damage the platform's source-of-truth database.
 */
export async function assertReadOnly(client: pg.Client | pg.Pool): Promise<{ user: string; database: string }> {
  const { rows } = await client.query(
    `SELECT current_user AS user,
            current_database() AS database,
            has_table_privilege(current_user, 'fixtures', 'INSERT')  AS can_insert,
            has_table_privilege(current_user, 'fixtures', 'UPDATE')  AS can_update,
            has_table_privilege(current_user, 'fixtures', 'DELETE')  AS can_delete,
            has_table_privilege(current_user, 'fixtures', 'SELECT')  AS can_select`,
  );
  const row = rows[0];
  if (!row?.can_select) {
    throw new Error(`read-only check failed: ${row?.user} cannot SELECT from fixtures`);
  }
  if (row.can_insert || row.can_update || row.can_delete) {
    throw new Error(
      `TRAIN_DATABASE_URL is not read-only (INSERT=${row.can_insert}, UPDATE=${row.can_update}, DELETE=${row.can_delete}). ` +
        'Use the football_readonly role from migration 0008_prediction_readonly_role.sql.',
    );
  }
  return { user: String(row.user), database: String(row.database) };
}
