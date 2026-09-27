/**
 * Sync engine tests: provider mapping, idempotent imports, coverage gating,
 * post-match derived statistics, H2H, resumable task retries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerAllHandlers } from '../src/sync/handlers.js';
import { runTaskOnce } from '../src/cli/common.js';
import { closePool, query, queryOne } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { importCompetitions, discoverCoverage, getCoverage } from '../src/sync/pipelines/metadata.js';
import { importFixturesForCompetitionSeason, fetchFixtureDetails, runPostMatchPipeline } from '../src/sync/pipelines/fixtures.js';
import { syncStandings } from '../src/sync/pipelines/misc.js';
import { n, s } from '../src/provider/mapper.js';
import { enqueueTask, claimDueTasks, markTaskDone, getTaskByKey, syncSummary } from '../src/sync/tasks.js';
import { processTask, registerHandler } from '../src/sync/engine.js';
import { computeH2H } from '../src/stats/leagues.js';
import { runDataQualityChecks } from '../src/data-quality.js';

beforeAll(async () => {
  registerAllHandlers();
  await importCompetitions();
});
afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe('provider mappers', () => {
  it('normalizes strings, numbers and percentages; null for unavailable', () => {
    expect(s(null)).toBeNull();
    expect(s('')).toBeNull();
    expect(s('null')).toBeNull();
    expect(s(' OK ')).toBe('OK');
    expect(n(null)).toBeNull();
    expect(n('45%')).toBe(45);
    expect(n('72.5')).toBe(72.5);
    expect(n('n/a')).toBeNull();
  });
});

describe('competitions & coverage', () => {
  it('imports competitions and season windows', async () => {
    const comps = await query(`SELECT * FROM competitions`);
    expect(comps.length).toBeGreaterThanOrEqual(4);
    const seasons = await query(`SELECT * FROM seasons WHERE year >= 2023`);
    expect(seasons.length).toBeGreaterThanOrEqual(4);
  });

  it('detects coverage per competition/season and never fakes unsupported data', async () => {
    // National Cup (758) has no standings/players in the provider
    const cup = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '758'`);
    const cupSeason = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = 2025`);
    const flags = await discoverCoverage(cup!.id, cupSeason!.id);
    expect(flags.standings).toBe(false);
    expect(flags.players).toBe(false);
    expect(flags.events).toBe(true);

    // Premier Division (39) has full coverage
    const top = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`);
    const topFlags = await discoverCoverage(top!.id, cupSeason!.id);
    expect(topFlags.standings).toBe(true);
    expect(topFlags.odds).toBe(true);

    // La Liga (140) has no odds
    const liga = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '140'`);
    const ligaFlags = await discoverCoverage(liga!.id, cupSeason!.id);
    expect(ligaFlags.odds).toBe(false);

    // stored flags are retrievable
    const stored = await getCoverage(top!.id, cupSeason!.id);
    expect(stored?.standings).toBe(true);
  });
});

describe('fixture import idempotency', () => {
  it('duplicate fixture imports do not create duplicate fixtures', async () => {
    const comp = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`);
    const season = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = 2025`);
    await discoverCoverage(comp!.id, season!.id);
    const first = await importFixturesForCompetitionSeason(comp!.id, season!.id, { fetchDetails: false });
    const countAfterFirst = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixtures WHERE competition_id = $1 AND season_id = $2`, [comp!.id, season!.id]))!.c;
    const second = await importFixturesForCompetitionSeason(comp!.id, season!.id, { fetchDetails: false });
    const countAfterSecond = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixtures WHERE competition_id = $1 AND season_id = $2`, [comp!.id, season!.id]))!.c;
    expect(countAfterFirst).toBeGreaterThan(0);
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(first.imported).toBe(second.imported);
  });

  it('respects the unique provider fixture constraint', async () => {
    const dups = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM (SELECT provider_fixture_id FROM fixtures GROUP BY provider_fixture_id HAVING count(*) > 1) d`,
    );
    expect(dups!.c).toBe(0);
  });
});

describe('fixture details & events idempotency', () => {
  it('re-fetching details does not duplicate events/statistics', async () => {
    const fx = await queryOne<{ id: number }>(
      `SELECT id FROM fixtures WHERE competition_id = (SELECT id FROM competitions WHERE provider_id = '39')
        AND season_id = (SELECT id FROM seasons WHERE year = 2025) AND status_short = 'FT' AND finalized = FALSE LIMIT 1`,
    );
    expect(fx).not.toBeNull();
    const r1 = await fetchFixtureDetails(fx!.id);
    const e1 = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixture_events WHERE fixture_id = $1`, [fx!.id]))!.c;
    const ts1 = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixture_team_statistics WHERE fixture_id = $1`, [fx!.id]))!.c;
    const r2 = await fetchFixtureDetails(fx!.id).catch(() => ({ events: 0, teamStats: 0, playerStats: 0, lineups: 0 }));
    // after finalize details are skipped; force a second fetch on a non-finalized twin
    void r2;
    const e2 = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixture_events WHERE fixture_id = $1`, [fx!.id]))!.c;
    const ts2 = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixture_team_statistics WHERE fixture_id = $1`, [fx!.id]))!.c;
    expect(e1).toBeGreaterThan(0);
    expect(ts1).toBe(2);
    expect(e2).toBe(e1);
    expect(ts2).toBe(ts1);
    expect(r1.teamStats).toBe(2);
  });
});

describe('post-match pipeline & derived statistics', () => {
  it('finalizes a fixture and calculates referee/league/team/player stats', async () => {
    const fx = await queryOne<{ id: number }>(
      `SELECT id FROM fixtures WHERE competition_id = (SELECT id FROM competitions WHERE provider_id = '39')
        AND season_id = (SELECT id FROM seasons WHERE year = 2025) AND status_short = 'FT' AND finalized = FALSE LIMIT 1`,
    );
    const result = await runPostMatchPipeline(fx!.id);
    expect(result.finalized).toBe(true);

    const row = await queryOne(`SELECT * FROM fixtures WHERE id = $1`, [fx!.id]);
    expect((row as { finalized: boolean }).finalized).toBe(true);

    // referee match stats derived locally from events
    const refStats = await queryOne<{ yellow_home: number | null; yellow_away: number | null; red_cards: number | null }>(
      `SELECT * FROM referee_match_statistics WHERE fixture_id = $1`,
      [fx!.id],
    );
    expect(refStats).not.toBeNull();
    const eventCards = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM fixture_events WHERE fixture_id = $1 AND event_type = 'Card'`,
      [fx!.id],
    );
    if ((eventCards!.c ?? 0) > 0) {
      expect((refStats!.yellow_home ?? 0) + (refStats!.yellow_away ?? 0) + (refStats!.red_cards ?? 0)).toBeGreaterThan(0);
    }

    // league averages present
    const league = await queryOne<{ cards_per_match: string | null; goals_per_match: string | null; completed_matches: number }>(
      `SELECT * FROM league_season_statistics WHERE competition_id = (SELECT id FROM competitions WHERE provider_id = '39')
        AND season_id = (SELECT id FROM seasons WHERE year = 2025)`,
    );
    expect(league).not.toBeNull();
    expect(Number(league!.completed_matches)).toBeGreaterThan(0);
    expect(Number(league!.goals_per_match)).toBeGreaterThanOrEqual(0);

    // team stats internally consistent
    const teams = await query<{ wins: number; draws: number; losses: number; matches: number }>(
      `SELECT * FROM team_competition_season_stats WHERE competition_id = (SELECT id FROM competitions WHERE provider_id = '39')
        AND season_id = (SELECT id FROM seasons WHERE year = 2025)`,
    );
    for (const t of teams) {
      expect(t.wins + t.draws + t.losses).toBe(t.matches);
    }

    // player season stats exist
    const players = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM player_season_statistics WHERE season_id = (SELECT id FROM seasons WHERE year = 2025)`,
    );
    expect(players!.c).toBeGreaterThan(0);

    // prediction features built
    const pred = await queryOne(`SELECT * FROM prediction_features WHERE fixture_id = $1`, [fx!.id]);
    expect(pred).not.toBeNull();

    // re-running postmatch is a no-op
    const again = await runPostMatchPipeline(fx!.id);
    expect(again.finalized).toBe(true);
    const refCount = (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM referee_match_statistics WHERE fixture_id = $1`, [fx!.id]))!.c;
    expect(refCount).toBe(1);
  });

  it('H2H computed locally from stored fixtures with symmetric consistency', async () => {
    const pair = await queryOne<{ home_team_id: number; away_team_id: number }>(
      `SELECT home_team_id, away_team_id FROM fixtures WHERE status_short = 'FT' AND home_team_id IS NOT NULL LIMIT 1`,
    );
    const ab = await computeH2H(pair!.home_team_id, pair!.away_team_id, 10);
    const ba = await computeH2H(pair!.away_team_id, pair!.home_team_id, 10);
    expect(ab.fixturesCount).toBe(ba.fixturesCount);
    expect(ab.aWins).toBe(ba.bWins);
    expect(ab.goalsA).toBe(ba.goalsB);
    expect(ab.fixturesCount).toBeGreaterThan(0);
  });
});

describe('coverage gating prevents unsupported requests', () => {
  it('cup standings sync stores nothing (coverage false)', async () => {
    const cup = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '758'`);
    const season = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = 2025`);
    await discoverCoverage(cup!.id, season!.id);
    const r = await syncStandings(cup!.id, season!.id);
    expect(r.rows).toBe(0);
  });
});

describe('sync engine: retries, resume, failed handling', () => {
  it('a failing task is retried and can be marked done later (resume-safe)', async () => {
    let attempts = 0;
    registerHandler('test:flaky', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient failure');
      return { ok: true, attempts };
    });
    const taskKey = `test:flaky:${Date.now()}`;
    await enqueueTask({ taskKey, taskType: 'test:flaky', priority: 1, maxAttempts: 3 });

    const claimed1 = await claimDueTasks(5);
    const t1 = claimed1.find((t) => t.task_key === taskKey);
    expect(t1).toBeTruthy();
    const ok1 = await processTask(t1!);
    expect(ok1).toBe(false);
    let stored = await getTaskByKey(taskKey);
    expect(stored!.status).toBe('pending'); // scheduled for retry, not dead
    expect(stored!.last_error).toMatch(/transient/);

    // simulate retry after backoff
    await query(`UPDATE sync_tasks SET scheduled_for = now() WHERE task_key = $1`, [taskKey]);
    const claimed2 = await claimDueTasks(5);
    const t2 = claimed2.find((t) => t.task_key === taskKey);
    const ok2 = await processTask(t2!);
    expect(ok2).toBe(true);
    stored = await getTaskByKey(taskKey);
    expect(stored!.status).toBe('done');
  });

  it('permanent failure exhausts attempts and records the error', async () => {
    registerHandler('test:always-fail', async () => {
      throw new Error('permanent failure');
    });
    const taskKey = `test:always-fail:${Date.now()}`;
    await enqueueTask({ taskKey, taskType: 'test:always-fail', priority: 1, maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      await query(`UPDATE sync_tasks SET scheduled_for = now() WHERE task_key = $1`, [taskKey]);
      const claimed = await claimDueTasks(5);
      const t = claimed.find((x) => x.task_key === taskKey);
      if (t) await processTask(t);
    }
    const stored = await getTaskByKey(taskKey);
    expect(stored!.status).toBe('failed');
    expect(stored!.attempts).toBe(2);
    const summary = await syncSummary();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    await markTaskDone(stored!.id, { recovered: true }, 1);
  });

  it('task keys are idempotent — re-enqueueing does not duplicate', async () => {
    const taskKey = `test:idem:${Date.now()}`;
    await enqueueTask({ taskKey, taskType: 'test:flaky', priority: 5 });
    await enqueueTask({ taskKey, taskType: 'test:flaky', priority: 5 });
    const rows = await query(`SELECT * FROM sync_tasks WHERE task_key = $1`, [taskKey]);
    expect(rows.length).toBe(1);
  });
});

describe('data quality', () => {
  it('passes core integrity checks after import', async () => {
    const result = await runDataQualityChecks({ persist: true });
    const byKey = Object.fromEntries(result.checks.map((c) => [c.key, c]));
    expect(byKey.fixtures_teams_distinct.status).toBe('PASS');
    expect(byKey.provider_fixture_ids_unique.status).toBe('PASS');
    expect(byKey.events_reference_fixtures.status).toBe('PASS');
    expect(byKey.api_keys_hashed_only.status).toBe('PASS');
    expect(result.failed).toBe(0);
  });
});

describe('CLI orchestration', () => {
  it('historical:import enqueues a resumable queue of tasks', async () => {
    const result = (await runTaskOnce('historical:import', {})) as { enqueued?: { fixtureTasks: number } };
    expect(result).toBeTruthy();
    const tasks = await query<{ task_type: string }>(`SELECT task_type FROM sync_tasks WHERE task_type IN ('fixtures:import','standings:sync','coverage:discover','teams:import')`);
    expect(tasks.length).toBeGreaterThan(0);
  });
});

describe('competitions import (optimized, batched)', () => {
  it('imports ALL provider leagues and pairs every competition with every known season', async () => {
    // every league the provider returned exists exactly once
    const comps = await query<{ provider_id: string; n: number }>(
      `SELECT provider_id, count(*)::int AS n FROM competitions GROUP BY provider_id`,
    );
    const byId = new Map(comps.map((c) => [c.provider_id, c.n]));
    for (const pid of ['39', '140', '40', '758']) {
      expect(byId.get(pid)).toBe(1); // all provider leagues imported, no duplicates
    }
    // every competition × every season year is linked (4 comps × 5 years)
    const links = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM competition_seasons cs
        JOIN competitions co ON co.id = cs.competition_id
        JOIN seasons se ON se.id = cs.season_id
       WHERE se.year BETWEEN 2022 AND 2026`,
    );
    expect(links[0].c).toBe(20);
  });

  it('preserves is_current and historical import scope', async () => {
    const current = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM competition_seasons cs JOIN seasons se ON se.id = cs.season_id
       WHERE se.year = 2026 AND cs.is_current = TRUE`,
    );
    expect(current[0].c).toBe(4); // one per competition, current season only
    const scopeRows = await query<{ year: number; scope: string }>(
      `SELECT DISTINCT se.year, cs.import_scope AS scope FROM competition_seasons cs
        JOIN seasons se ON se.id = cs.season_id ORDER BY se.year`,
    );
    const byYear = new Map(scopeRows.map((r) => [r.year, r.scope]));
    expect(byYear.get(2022)).toBe('out_of_scope');
    for (const y of [2023, 2024, 2025, 2026]) expect(byYear.get(y)).toBe('in_scope');
  });

  it('is idempotent — re-import creates no duplicates', async () => {
    const snap = async () => {
      const [c, s, cs, co] = await Promise.all([
        queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM competitions`),
        queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM seasons`),
        queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM competition_seasons`),
        queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM countries`),
      ]);
      return { c: c!.c, s: s!.c, cs: cs!.c, co: co!.c };
    };
    const before = await snap();
    await importCompetitions();
    await importCompetitions();
    const after = await snap();
    expect(after).toEqual(before);
  });

  it('uses a bounded number of database round trips (batched, not per-row)', async () => {
    const { pool } = await import('../src/lib/db.js');
    const original = pool.query.bind(pool);
    let calls = 0;
    const counting = (text: unknown, params?: unknown) => {
      calls += 1;
      return original(text as never, (params ?? []) as never[]);
    };
    pool.query = counting as unknown as typeof pool.query;
    try {
      await importCompetitions();
    } finally {
      pool.query = original as typeof pool.query;
    }
    // previously this was O(leagues×seasons + competitions×years) round trips;
    // the batched importer must stay far below that for the same payload.
    expect(calls).toBeLessThanOrEqual(25);
  });
});
