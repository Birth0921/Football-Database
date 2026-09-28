/**
 * Import-scope task handling: orphaned competition/season tasks, unsupported
 * competitions, the 2023–2026 season allowlist, scheduler scope filtering,
 * permanent (non-retryable) handling of missing targets, duplicate prevention
 * and stable historical imports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerAllHandlers } from '../src/sync/handlers.js';
import { closePool, query, queryOne } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { cleanupImportScope, enqueueSeasonWindowTasks, importCompetitions } from '../src/sync/pipelines/metadata.js';
import { importFixturesForCompetitionSeason } from '../src/sync/pipelines/fixtures.js';
import { claimDueTasks, claimTaskById, enqueueTask, getTaskByKey } from '../src/sync/tasks.js';
import { processTask, registerHandler } from '../src/sync/engine.js';
import {
  findScopedPair, isPermanentTaskError, isTaskInScope, ScopeSkipError, skipOutOfScopeTasks,
} from '../src/sync/scope-guard.js';
import { historicalImportSeasons, importTierForCompetition } from '../src/sync/import-scope.js';
import { config, currentSeasonFor, parseImportSeasons, rollingSeasonWindow } from '../src/config.js';

const P = `scope-test-${Date.now()}`;
let comp39 = 0;
let season2024 = 0;
let season2026 = 0;
let season2019 = 0;
let season2022 = 0;
let unsupportedComp = 0;

async function providerRequests(): Promise<number> {
  return (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM provider_requests`))!.c;
}

/** Insert a task row directly, like a stale row left behind by an older build. */
async function insertLegacyTask(key: string, type: string, params: Record<string, unknown>, status = 'pending', attempts = 3): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO sync_tasks (task_key, task_type, params, priority, status, attempts, max_attempts, scheduled_for)
     VALUES ($1, $2, $3, 45, $4, $5, 5, now() - interval '1 minute') RETURNING id`,
    [key, type, JSON.stringify(params), status, attempts],
  );
  return Number(row!.id);
}

beforeAll(async () => {
  registerAllHandlers();
  await importCompetitions();
  comp39 = Number((await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`))!.id);
  const yearId = async (y: number) => Number((await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = $1`, [y]))!.id);
  season2024 = await yearId(2024);
  season2026 = await yearId(2026);

  // Seasons outside the window. 2022 is deliberately mis-flagged 'in_scope'
  // to prove the year allowlist is enforced independently of the flag.
  season2019 = Number((await queryOne<{ id: number }>(
    `INSERT INTO seasons (year, display_name, import_scope) VALUES (2019, '2019', 'out_of_scope')
     ON CONFLICT (year) DO UPDATE SET import_scope = 'out_of_scope' RETURNING id`,
  ))!.id);
  season2022 = Number((await queryOne<{ id: number }>(
    `INSERT INTO seasons (year, display_name, import_scope) VALUES (2022, '2022', 'in_scope')
     ON CONFLICT (year) DO UPDATE SET import_scope = 'in_scope' RETURNING id`,
  ))!.id);
  // Competition NOT on the Tier 1–3 allowlist: the importer stores it (if at
  // all) inactive with no tier.
  unsupportedComp = Number((await queryOne<{ id: number }>(
    `INSERT INTO competitions (name, provider, provider_id, active, import_tier)
     VALUES ('Regional Amateur League', 'api-football', $1, FALSE, NULL) RETURNING id`,
    [`${P}-unsupported`],
  ))!.id);
  await query(
    `INSERT INTO competition_seasons (competition_id, season_id, import_scope) VALUES
       ($1, $2, 'out_of_scope'), ($1, $3, 'in_scope'), ($4, $5, 'in_scope')
     ON CONFLICT (competition_id, season_id) DO UPDATE SET import_scope = EXCLUDED.import_scope`,
    [comp39, season2019, season2022, unsupportedComp, season2026],
  );
});

afterAll(async () => {
  await query(`DELETE FROM sync_tasks WHERE task_key LIKE $1`, [`${P}%`]);
  await query(`DELETE FROM competition_seasons WHERE season_id = ANY($1::bigint[]) OR competition_id = $2`, [[season2019, season2022], unsupportedComp]);
  await query(`DELETE FROM competitions WHERE id = $1`, [unsupportedComp]);
  await query(`DELETE FROM seasons WHERE id = ANY($1::bigint[])`, [[season2019, season2022]]);
  await closeRedis();
  await closePool();
});

describe('season allowlist', () => {
  it('rolling 4-season window: 2026 → 2023–2026, 2027 → 2024–2027, 2028 → 2025–2028', () => {
    expect(rollingSeasonWindow(2026)).toEqual([2023, 2024, 2025, 2026]);
    expect(rollingSeasonWindow(2027)).toEqual([2024, 2025, 2026, 2027]);
    expect(rollingSeasonWindow(2028)).toEqual([2025, 2026, 2027, 2028]);
    expect(currentSeasonFor(new Date('2026-12-31T23:59:59Z'))).toBe(2026);
    expect(currentSeasonFor(new Date('2027-01-01T00:00:00Z'))).toBe(2027);
    expect(config.importSeasons).toEqual(rollingSeasonWindow(currentSeasonFor()));
    expect(config.importSeasons).toHaveLength(4);
  });

  it('IMPORT_SEASONS can never widen or pin the window (stale values are ignored, not fatal)', () => {
    const in2027 = new Date('2027-03-01T00:00:00Z');
    expect(parseImportSeasons(undefined, in2027)).toEqual([2024, 2025, 2026, 2027]);
    expect(parseImportSeasons('rolling', in2027)).toEqual([2024, 2025, 2026, 2027]);
    expect(parseImportSeasons('2027,2026,2025,2024', in2027)).toEqual([2024, 2025, 2026, 2027]);
    for (const bad of ['2023,2024,2025,2026', '2022,2023,2024,2025,2026,2027', '2027', 'all', '1990,2030']) {
      expect(parseImportSeasons(bad, in2027), bad).toEqual([2024, 2025, 2026, 2027]);
    }
    expect(historicalImportSeasons([2024, 2025, 2026, 2027], 2027)).toEqual([2024, 2025, 2026]);
  });

  it('pairs with a season outside 2023–2026 are never in scope, even if mis-flagged', async () => {
    expect(await findScopedPair(comp39, season2026)).not.toBeNull();
    expect(await findScopedPair(comp39, season2019)).toBeNull();
    expect(await findScopedPair(comp39, season2022)).toBeNull(); // flag says in_scope, year says no
  });
});

describe('unsupported competition filtering', () => {
  it('only Tier 1–3 competitions resolve to a tier', () => {
    expect(importTierForCompetition({ id: 987654, name: 'Regional Amateur League' })).toBeNull();
    for (const name of ['UEFA Nations League', 'FIFA World Cup', "FIFA Women's World Cup", 'UEFA Champions League']) {
      expect(importTierForCompetition({ name }), name).not.toBeNull();
    }
  });

  it('an unsupported competition (inactive, no tier) is out of scope', async () => {
    expect(await findScopedPair(unsupportedComp, season2026)).toBeNull();
    expect(await isTaskInScope('teams:import', { competitionId: unsupportedComp, seasonId: season2026 })).toBe(false);
  });

  it('missing ids and malformed params are out of scope; unscoped task types are unaffected', async () => {
    expect(await findScopedPair(999_999_999, 999_999_999)).toBeNull();
    expect(await findScopedPair('abc', undefined)).toBeNull();
    expect(await isTaskInScope('teams:import', {})).toBe(false);
    expect(await isTaskInScope('fixture:details', { fixtureId: 999_999_999 })).toBe(false);
    expect(await isTaskInScope('live:sync', {})).toBe(true);
    expect(await isTaskInScope('upcoming:sync', { daysAhead: 7 })).toBe(true);
  });
});

describe('enqueue guard + duplicate prevention', () => {
  it('rejects teams:import for missing, unsupported and out-of-scope pairs', async () => {
    const cases = [
      { competitionId: 999_999_999, seasonId: 999_999_999 },
      { competitionId: unsupportedComp, seasonId: season2026 },
      { competitionId: comp39, seasonId: season2019 },
      { competitionId: comp39, seasonId: season2022 },
    ];
    for (const [i, params] of cases.entries()) {
      const key = `${P}:enqueue-reject:${i}`;
      expect(await enqueueTask({ taskKey: key, taskType: 'teams:import', params, priority: 45 })).toBe(0);
      expect(await getTaskByKey(key)).toBeNull();
    }
  });

  it('accepts an in-scope pair exactly once (idempotent task key)', async () => {
    const key = `${P}:enqueue-ok`;
    const params = { competitionId: comp39, seasonId: season2026 };
    const a = await enqueueTask({ taskKey: key, taskType: 'teams:import', params, priority: 45, scheduledFor: new Date(Date.now() + 3600_000) });
    const b = await enqueueTask({ taskKey: key, taskType: 'teams:import', params, priority: 45, scheduledFor: new Date(Date.now() + 3600_000) });
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a);
    expect((await query(`SELECT id FROM sync_tasks WHERE task_key = $1`, [key])).length).toBe(1);
  });
});

describe('orphaned competition/season tasks', () => {
  it('the sweep marks stale pending/failed orphans skipped, keeps valid work, and is idempotent', async () => {
    const orphanPending = await insertLegacyTask(`${P}:orphan-pending`, 'teams:import', { competitionId: 999_999_998, seasonId: 18 }, 'pending', 3);
    const orphanFailed = await insertLegacyTask(`${P}:orphan-failed`, 'teams:import', { competitionId: 999_999_997, seasonId: 24 }, 'failed', 4);
    const orphanOut = await insertLegacyTask(`${P}:orphan-2019`, 'standings:sync', { competitionId: comp39, seasonId: season2019 });
    const orphanUnsupported = await insertLegacyTask(`${P}:orphan-unsupported`, 'coverage:discover', { competitionId: unsupportedComp, seasonId: season2026 });
    const orphanFixture = await insertLegacyTask(`${P}:orphan-fixture`, 'fixture:details', { fixtureId: 999_999_996 });
    const orphanMalformed = await insertLegacyTask(`${P}:orphan-malformed`, 'teams:import', { competitionId: 'x' });
    const valid = await insertLegacyTask(`${P}:valid`, 'teams:import', { competitionId: comp39, seasonId: season2026 }, 'pending', 0);
    const doneOrphan = await insertLegacyTask(`${P}:done-orphan`, 'teams:import', { competitionId: 999_999_995, seasonId: 1 }, 'done', 1);
    const liveTask = await insertLegacyTask(`${P}:live`, 'live:sync', {}, 'pending', 0);

    const res = await skipOutOfScopeTasks();
    expect(res.skipped).toBeGreaterThanOrEqual(6);

    const status = async (id: number) => (await queryOne<{ status: string }>(`SELECT status FROM sync_tasks WHERE id = $1`, [id]))!.status;
    for (const id of [orphanPending, orphanFailed, orphanOut, orphanUnsupported, orphanFixture, orphanMalformed]) {
      expect(await status(id)).toBe('skipped');
    }
    expect(await status(valid)).toBe('pending');
    expect(await status(doneOrphan)).toBe('done');
    expect(await status(liveTask)).toBe('pending');

    // idempotent: nothing left to skip among our rows
    await skipOutOfScopeTasks();
    const claimed = await claimDueTasks(500);
    const claimedIds = new Set(claimed.map((t) => Number(t.id)));
    for (const id of [orphanPending, orphanFailed, orphanOut, orphanUnsupported, orphanFixture, orphanMalformed]) {
      expect(claimedIds.has(id)).toBe(false); // skipped rows are never claimed again
    }
    // release anything we claimed so other tests are unaffected
    await query(`UPDATE sync_tasks SET status = 'pending', attempts = GREATEST(attempts - 1, 0) WHERE id = ANY($1::bigint[])`, [[...claimedIds]]);
  });

  it('re-enqueueing a skipped orphan does not revive it', async () => {
    const key = `${P}:orphan-pending`;
    expect(await enqueueTask({ taskKey: key, taskType: 'teams:import', params: { competitionId: 999_999_998, seasonId: 18 } })).toBe(0);
    expect((await getTaskByKey(key))!.status).toBe('skipped');
  });

  it('cleanupImportScope also skips queued work for pairs that just left the scope', async () => {
    const key = `${P}:cleanup-orphan`;
    // stale flags left behind by an older, wider scope
    await query(`UPDATE competitions SET active = TRUE, import_tier = 3 WHERE id = $1`, [unsupportedComp]);
    await insertLegacyTask(key, 'injuries:sync', { competitionId: unsupportedComp, seasonId: season2026 });
    const res = await cleanupImportScope();
    expect(res.skippedTasks).toBeGreaterThanOrEqual(1);
    expect((await getTaskByKey(key))!.status).toBe('skipped');
    const comp = await queryOne<{ active: boolean }>(`SELECT active FROM competitions WHERE id = $1`, [unsupportedComp]);
    expect(comp!.active).toBe(false);
  });
});

describe('missing competition/season is permanent, never retryable', () => {
  it('a claimed legacy orphan is skipped by the engine without any provider request', async () => {
    const key = `${P}:engine-orphan`;
    const id = await insertLegacyTask(key, 'teams:import', { competitionId: 999_999_994, seasonId: 25 }, 'pending', 3);
    const claimed = await claimTaskById(id);
    expect(claimed).toBeTruthy();
    const before = await providerRequests();
    await processTask(claimed!);
    expect(await providerRequests()).toBe(before);
    const row = await getTaskByKey(key);
    expect(row!.status).toBe('skipped');
    expect(row!.attempts).toBe(4); // not reset, not rescheduled
    expect(await claimTaskById(id)).toBeNull();
  });

  it('legacy "competition/season not found" errors and ScopeSkipError are skipped, not retried', async () => {
    registerHandler('test:legacy-missing', async () => { throw new Error('competition/season not found: 1363/18'); });
    registerHandler('test:scope-skip', async () => { throw new ScopeSkipError('competition/season not found or outside import scope: 1/2'); });
    for (const type of ['test:legacy-missing', 'test:scope-skip']) {
      const key = `${P}:${type}`;
      const id = await enqueueTask({ taskKey: key, taskType: type, priority: 1, maxAttempts: 5 });
      await processTask((await claimTaskById(id))!);
      const row = await getTaskByKey(key);
      expect(row!.status, type).toBe('skipped');
      expect(row!.attempts, type).toBe(1);
    }
    expect(isPermanentTaskError(new Error('competition/season not found: 814/18'))).toBe(true);
    expect(isPermanentTaskError(new Error('competition/season outside import scope: 1/2'))).toBe(true);
    expect(isPermanentTaskError(new Error('fixture 12 not found'))).toBe(true);
    expect(isPermanentTaskError(new Error('ECONNRESET'))).toBe(false);
    expect(isPermanentTaskError(new Error('provider HTTP 500'))).toBe(false);
  });

  it('transient errors still use normal retry/backoff', async () => {
    registerHandler('test:transient-scope', async () => { throw new Error('socket hang up'); });
    const key = `${P}:transient`;
    const id = await enqueueTask({ taskKey: key, taskType: 'test:transient-scope', priority: 1, maxAttempts: 5 });
    await processTask((await claimTaskById(id))!);
    const row = await getTaskByKey(key);
    expect(row!.status).toBe('pending');
    expect(new Date(row!.scheduled_for).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('scheduler scope filtering + stable historical imports', () => {
  it('season-window enqueue only queues in-scope pairs that were never imported', async () => {
    await query(`DELETE FROM sync_tasks WHERE task_type = 'fixtures:import'`);
    const res = await enqueueSeasonWindowTasks();
    const rows = await query<{ competition_id: string; year: number; priority: number; historical_imported_at: string | null; current_bootstrapped_at: string | null; active: boolean; import_tier: number | null }>(
      `SELECT (t.params->>'competitionId') AS competition_id, se.year, t.priority, c.active, c.import_tier,
              cs.historical_imported_at, cs.current_bootstrapped_at
         FROM sync_tasks t
         JOIN competitions c ON c.id = (t.params->>'competitionId')::bigint
         JOIN seasons se ON se.id = (t.params->>'seasonId')::bigint
         JOIN competition_seasons cs ON cs.competition_id = c.id AND cs.season_id = se.id
        WHERE t.task_type = 'fixtures:import'`,
    );
    expect(rows.length).toBe(res.tasks);
    for (const r of rows) {
      expect([2023, 2024, 2025, 2026]).toContain(r.year);
      expect(r.active).toBe(true);
      expect([1, 2, 3]).toContain(r.import_tier);
      expect(Number(r.competition_id)).not.toBe(unsupportedComp);
      if (r.year === 2026) {
        expect(r.current_bootstrapped_at).toBeNull();
        expect(r.priority).toBe(35);
      } else {
        expect(r.historical_imported_at).toBeNull();
        expect(r.priority).toBe(55);
      }
    }
  });

  it('a completed historical pair makes no provider request and chains no follow-ups', async () => {
    await importFixturesForCompetitionSeason(comp39, season2024, { fetchDetails: false }); // sets the marker
    const marked = await queryOne<{ h: string | null }>(
      `SELECT historical_imported_at AS h FROM competition_seasons WHERE competition_id = $1 AND season_id = $2`,
      [comp39, season2024],
    );
    expect(marked!.h).not.toBeNull();

    const before = await providerRequests();
    const key = `${P}:historical-again`;
    const id = await enqueueTask({ taskKey: key, taskType: 'fixtures:import', params: { competitionId: comp39, seasonId: season2024, fetchDetails: false }, priority: 1 });
    await processTask((await claimTaskById(id))!);
    expect(await providerRequests()).toBe(before);
    const row = await getTaskByKey(key);
    expect(row!.status).toBe('done');
    const summary = row!.result_summary as { alreadyImported?: boolean; chainedFollowUps?: boolean };
    expect(summary.alreadyImported).toBe(true);
    expect(summary.chainedFollowUps).toBe(false);

    // and the season window never re-queues it
    await query(`DELETE FROM sync_tasks WHERE task_key = $1`, [`fixtures:import:${comp39}:${season2024}`]);
    await enqueueSeasonWindowTasks();
    expect(await getTaskByKey(`fixtures:import:${comp39}:${season2024}`)).toBeNull();
  }, 240_000);

  it('current season follow-ups remain enqueueable (2026 is never frozen)', async () => {
    const key = `${P}:current-teams`;
    const id = await enqueueTask({ taskKey: key, taskType: 'teams:import', params: { competitionId: comp39, seasonId: season2026 }, priority: 45, scheduledFor: new Date(Date.now() + 3600_000) });
    expect(id).toBeGreaterThan(0);
  });
});
