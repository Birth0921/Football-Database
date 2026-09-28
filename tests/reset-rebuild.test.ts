/**
 * Clean rebuild: imported-data reset (protected configuration survives,
 * FK-safe, idempotent, confirmation-gated) followed by the approved
 * Tier 1–3 / 2023–2026 import (classification, one-time historical and 2026
 * bootstrap, current sync, priorities, quota backoff, duplicate prevention,
 * restart recovery, scope report).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerAllHandlers } from '../src/sync/handlers.js';
import { closePool, query, queryOne } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { enqueueSeasonWindowTasks, importCompetitions } from '../src/sync/pipelines/metadata.js';
import { importFixturesForCompetitionSeason, syncUpcomingFixtures } from '../src/sync/pipelines/fixtures.js';
import { claimDueTasks, claimTaskById, enqueueTask, getTaskByKey, requeueStuckTasks } from '../src/sync/tasks.js';
import { drainDueTasks, processTask } from '../src/sync/engine.js';
import { runTaskOnce } from '../src/cli/common.js';
import { createKey } from '../src/keys/service.js';
import {
  assertResetPlanValid, planImportedDataReset, PROTECTED_TABLES, RESET_CONFIRM_PHRASE, RESET_TABLES, resetImportedData,
} from '../src/maintenance/reset-imported-data.js';
import { buildImportScopeReport } from '../src/maintenance/import-report.js';
import { classifyCompetition, filterApprovedLeagues } from '../src/sync/import-scope.js';
import { skipOutOfScopeTasks } from '../src/sync/scope-guard.js';

async function tableFingerprint(table: string): Promise<string> {
  const row = await queryOne<{ h: string }>(
    `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM "${table}" t`,
  );
  return row!.h;
}

async function protectedFingerprints(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of PROTECTED_TABLES) out[t] = await tableFingerprint(t);
  return out;
}

async function providerRequests(): Promise<number> {
  return (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM provider_requests`))!.c;
}

async function count(table: string): Promise<number> {
  return (await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM "${table}"`))!.c;
}

let apiKeyId = 0;

beforeAll(async () => {
  registerAllHandlers();
  // --- imported football data + queue state (to be reset) -----------------
  await importCompetitions();
  const comp = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`);
  const season = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = 2025`);
  await importFixturesForCompetitionSeason(comp!.id, season!.id, { fetchDetails: false });
  // stale/orphan queue rows like the ones seen in production
  for (const [c, s] of [[1363, 18], [814, 18], [2249, 24], [637, 25], [106, 17]]) {
    await query(
      `INSERT INTO sync_tasks (task_key, task_type, params, priority, status, attempts, max_attempts)
       VALUES ($1, 'teams:import', $2, 45, 'pending', 3, 5) ON CONFLICT (task_key) DO NOTHING`,
      [`teams:${c}:${s}`, JSON.stringify({ competitionId: c, seasonId: s })],
    );
  }
  await query(`INSERT INTO sync_state (state_key, state) VALUES ('reset-test', '{"cursor": 1}') ON CONFLICT DO NOTHING`);

  // --- protected configuration (must survive) ------------------------------
  const key = await createKey({ clientName: 'reset-test-client', scopes: ['fixtures:read'], label: 'reset-test' }, 'test');
  apiKeyId = Number(key.id);
  await query(`INSERT INTO managed_key_secrets (api_key_id, enc_text) VALUES ($1, 'v1:test-only:not-a-secret') ON CONFLICT DO NOTHING`, [apiKeyId]);
  await query(`INSERT INTO api_usage (client_id, api_key_id, endpoint, requests) VALUES ($1, $2, '/fixtures', 3)`, [key.clientId, apiKeyId]);
  const { quotaManager } = await import('../src/sync/quota.js');
  await quotaManager.status(); // ensures today's provider_quota row exists
});

afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe('reset plan validation (FK-safe ordering)', () => {
  it('the live schema is fully classified and the delete order respects every foreign key', async () => {
    const plan = await planImportedDataReset();
    expect(plan.tables.map((t) => t.table)).toEqual([...RESET_TABLES]);
    expect(plan.totalRows).toBeGreaterThan(0);
  });

  it('rejects a parent deleted before its child, protected→reset references, and unclassified tables', () => {
    const tables = ['a_child', 'a_parent', 'cfg'];
    expect(() => assertResetPlanValid(tables, [{ child: 'a_child', parent: 'a_parent' }], ['a_child', 'a_parent'], ['cfg'])).not.toThrow();
    expect(() => assertResetPlanValid(tables, [{ child: 'a_child', parent: 'a_parent' }], ['a_parent', 'a_child'], ['cfg']))
      .toThrow(/would be deleted after/);
    expect(() => assertResetPlanValid(tables, [{ child: 'cfg', parent: 'a_parent' }], ['a_child', 'a_parent'], ['cfg']))
      .toThrow(/protected table cfg references reset table a_parent/);
    expect(() => assertResetPlanValid([...tables, 'mystery'], [], ['a_child', 'a_parent'], ['cfg'])).toThrow(/unclassified tables mystery/);
    expect(() => assertResetPlanValid(tables, [], ['a_child', 'a_parent', 'cfg'], ['cfg'])).toThrow(/both reset and protected/);
  });

  it('protected configuration tables are never in the reset set', () => {
    for (const t of ['api_clients', 'api_keys', 'managed_key_secrets', 'api_usage', 'api_audit_log', 'schema_migrations', 'provider_quota', 'provider_requests']) {
      expect(PROTECTED_TABLES as readonly string[]).toContain(t);
      expect(RESET_TABLES as readonly string[]).not.toContain(t);
    }
  });
});

describe('imported-data reset', () => {
  it('dry run (no/incorrect confirmation) deletes nothing', async () => {
    const fixturesBefore = await count('fixtures');
    const dry = await resetImportedData({ skipRedis: true });
    expect(dry.mode).toBe('dry-run');
    const wrong = await resetImportedData({ confirm: 'yes', skipRedis: true });
    expect(wrong.mode).toBe('dry-run');
    expect(await count('fixtures')).toBe(fixturesBefore);
    expect(fixturesBefore).toBeGreaterThan(0);
  });

  it('production requires the explicit --production flag in addition to the confirmation', async () => {
    const fixturesBefore = await count('fixtures');
    await expect(resetImportedData({ confirm: RESET_CONFIRM_PHRASE, nodeEnv: 'production', skipRedis: true }))
      .rejects.toThrow(/--production/);
    expect(await count('fixtures')).toBe(fixturesBefore);
  });

  it('an unclassified table aborts the reset before anything is deleted', async () => {
    await query(`CREATE TABLE IF NOT EXISTS zz_unclassified_reset_probe (id int)`);
    try {
      const fixturesBefore = await count('fixtures');
      await expect(resetImportedData({ confirm: RESET_CONFIRM_PHRASE, nodeEnv: 'test', skipRedis: true }))
        .rejects.toThrow(/unclassified tables zz_unclassified_reset_probe/);
      expect(await count('fixtures')).toBe(fixturesBefore);
    } finally {
      await query(`DROP TABLE IF EXISTS zz_unclassified_reset_probe`);
    }
  });

  it('removes all imported football data + queue state and leaves protected configuration byte-identical', async () => {
    const before = await protectedFingerprints();
    const managedBefore = await queryOne<{ enc_text: string }>(`SELECT enc_text FROM managed_key_secrets WHERE api_key_id = $1`, [apiKeyId]);
    const quotaBefore = await queryOne(`SELECT daily_limit, daily_used, daily_remaining FROM provider_quota ORDER BY day DESC LIMIT 1`);

    const res = await resetImportedData({ confirm: RESET_CONFIRM_PHRASE, production: true, nodeEnv: 'production', skipRedis: true });
    expect(res.mode).toBe('executed');
    expect(res.totalDeleted).toBeGreaterThan(0);
    expect(res.protectedUnchanged).toBe(true);
    const deleted = Object.fromEntries(res.deleted.map((d) => [d.table, d.rows]));
    expect(deleted.fixtures).toBeGreaterThan(0);
    expect(deleted.competitions).toBeGreaterThan(0);
    expect(deleted.sync_tasks).toBeGreaterThanOrEqual(5); // incl. teams:1363:18 … teams:106:17

    for (const t of RESET_TABLES) expect(await count(t), t).toBe(0);
    for (const k of ['teams:1363:18', 'teams:814:18', 'teams:2249:24', 'teams:637:25', 'teams:106:17']) {
      expect(await getTaskByKey(k)).toBeNull();
    }

    expect(await protectedFingerprints()).toEqual(before);
    expect(await queryOne(`SELECT enc_text FROM managed_key_secrets WHERE api_key_id = $1`, [apiKeyId])).toEqual(managedBefore);
    expect(await queryOne(`SELECT daily_limit, daily_used, daily_remaining FROM provider_quota ORDER BY day DESC LIMIT 1`)).toEqual(quotaBefore);
    expect(await count('schema_migrations')).toBeGreaterThanOrEqual(6); // schema untouched
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const res = await resetImportedData({ confirm: RESET_CONFIRM_PHRASE, nodeEnv: 'test', skipRedis: true });
    expect(res.totalDeleted).toBe(0);
  });
});

describe('approved catalogue: Tier 1–3, men + women, club + national', () => {
  const catalogue = [
    { league: { id: 2, name: 'UEFA Champions League' } },
    { league: { id: 525, name: 'UEFA Champions League Women' } },
    { league: { id: 5, name: 'UEFA Nations League' } },
    { league: { id: 1, name: 'World Cup' } },
    { league: { id: 8, name: 'World Cup - Women' } },
    { league: { id: 44, name: "FA Women's Super League" } },
    { league: { id: 39, name: 'Premier League' } },
    { league: { id: 10, name: 'Friendlies' } },
    { league: { id: 99_001, name: 'Regional Amateur League' } },
    { league: { id: 99_002, name: 'Regional Women League' } },
    { league: { id: 99_003, name: 'Youth U19 League' } },
  ];

  it('keeps only approved Tier 1–3 entries and drops the rest of the provider catalogue', () => {
    const kept = filterApprovedLeagues(catalogue).map((k) => Number(k.entry.league.id));
    expect(kept.sort((a, b) => a - b)).toEqual([1, 2, 5, 8, 39, 44, 525]);
    for (const k of filterApprovedLeagues(catalogue)) expect([1, 2, 3]).toContain(k.profile.tier);
  });

  it('classifies men and women competitions (both in scope)', () => {
    expect(classifyCompetition({ id: 2, name: 'UEFA Champions League' })!.gender).toBe('men');
    expect(classifyCompetition({ id: 525, name: 'UEFA Champions League Women' })!.gender).toBe('women');
    expect(classifyCompetition({ id: 8, name: 'World Cup - Women' })!.gender).toBe('women');
    expect(classifyCompetition({ id: 44, name: "FA Women's Super League" })!.gender).toBe('women');
    expect(classifyCompetition({ name: "UEFA Women's Champions League" })!.gender).toBe('women');
    expect(classifyCompetition({ id: 99_002, name: 'Regional Women League' })).toBeNull(); // women but not approved
  });

  it('classifies club and national-team competitions (both in scope)', () => {
    expect(classifyCompetition({ id: 5, name: 'UEFA Nations League' })!.teamType).toBe('national');
    expect(classifyCompetition({ id: 1, name: 'World Cup' })!.teamType).toBe('national');
    expect(classifyCompetition({ id: 8, name: 'World Cup - Women' })!.teamType).toBe('national');
    expect(classifyCompetition({ id: 2, name: 'UEFA Champions League' })!.teamType).toBe('club');
    expect(classifyCompetition({ id: 525, name: 'UEFA Champions League Women' })!.teamType).toBe('club');
    expect(classifyCompetition({ id: 10, name: 'Friendlies' })).toBeNull(); // national but not approved
  });

  it('every required major competition is approved at Tier 1', () => {
    for (const name of ['UEFA Champions League', "UEFA Women's Champions League", 'UEFA Nations League', 'FIFA World Cup', "FIFA Women's World Cup"]) {
      expect(classifyCompetition({ name })?.tier, name).toBe(1);
    }
  });
});

describe('clean rebuild after reset', () => {
  it('rebuilds only approved competitions with seasons 2023–2026 and stores the profile', async () => {
    await importCompetitions();
    const report = await buildImportScopeReport();
    expect(report.seasons.inScope).toEqual([2023, 2024, 2025, 2026]);
    expect(report.seasons.outOfScopeRows).toBe(0);
    expect(report.competitions.active).toBe(4); // mock catalogue: 4 approved entries
    expect(report.competitions.outsideTier1to3Active).toBe(0);
    expect(report.competitionSeasons.outOfScopeYearsInScope).toBe(0);
    expect(report.competitionSeasons.inScope).toBe(16);
    const profiles = await query<{ gender: string; team_type: string }>(`SELECT gender, team_type FROM competitions WHERE active`);
    for (const p of profiles) {
      expect(['men', 'women']).toContain(p.gender);
      expect(['club', 'national']).toContain(p.team_type);
    }
  });

  it('2026 current sync runs first: today/upcoming by date + live + post-match', async () => {
    const before = await providerRequests();
    await runTaskOnce('current:sync', {}, `test:rebuild:current:${Date.now()}`);
    expect(await providerRequests()).toBeGreaterThan(before);
    const fx = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM fixtures f JOIN seasons se ON se.id = f.season_id WHERE se.year = 2026`,
    );
    expect(fx!.c).toBeGreaterThan(0);
  });

  it('one-time imports are queued once, by priority: 2026 bootstrap (35) before 2023–2025 history (55)', async () => {
    const first = await enqueueSeasonWindowTasks();
    expect(first.current).toBe(4);
    expect(first.historical).toBe(12);
    await enqueueSeasonWindowTasks(); // accidental second run
    const rows = await query<{ task_key: string; priority: number; year: number }>(
      `SELECT t.task_key, t.priority, se.year FROM sync_tasks t JOIN seasons se ON se.id = (t.params->>'seasonId')::bigint
        WHERE t.task_type = 'fixtures:import'`,
    );
    expect(rows.length).toBe(16); // duplicate prevention: one row per pair
    for (const r of rows) expect(r.priority).toBe(r.year === 2026 ? 35 : 55);
  });

  it('live > upcoming > recent > post-match > 2026 bootstrap > history in claim order', async () => {
    const now = Date.now();
    const keys = [
      ['live:sync', 10], ['upcoming:sync', 20], ['upcoming:sync', 22], ['postmatch:scan', 25],
    ] as const;
    for (const [type, priority] of keys) {
      await enqueueTask({ taskKey: `test:prio:${priority}:${now}`, taskType: type, params: priority === 22 ? { daysAhead: 0, daysBack: 2 } : {}, priority });
    }
    const claimed = await claimDueTasks(50);
    const priorities = claimed.map((t) => Number(t.priority));
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(priorities.slice(0, 4)).toEqual([10, 20, 22, 25]);
    expect(priorities).toContain(35);
    expect(priorities).toContain(55);
    expect(priorities.indexOf(35)).toBeLessThan(priorities.indexOf(55));
    // release the claims for the next tests
    await query(`UPDATE sync_tasks SET status = 'pending', attempts = GREATEST(attempts - 1, 0) WHERE id = ANY($1::bigint[])`, [claimed.map((t) => t.id)]);
    await query(`DELETE FROM sync_tasks WHERE task_key LIKE 'test:prio:%'`);
  });

  it('historical work is deferred with backoff under constrained quota while live sync keeps running', async () => {
    const { quotaManager } = await import('../src/sync/quota.js');
    const s0 = await quotaManager.status();
    const remaining = Math.max(s0.essentialReserve + 1, s0.backgroundFloor - 500);
    await quotaManager.observeExternal(s0.dailyLimit - remaining, s0.dailyLimit);
    try {
      const hist = await queryOne<{ id: number }>(
        `SELECT t.id FROM sync_tasks t JOIN seasons se ON se.id = (t.params->>'seasonId')::bigint
          WHERE t.task_type = 'fixtures:import' AND se.year = 2023 LIMIT 1`,
      );
      const before = await providerRequests();
      await processTask((await claimTaskById(hist!.id))!);
      expect(await providerRequests()).toBe(before);
      const row = await queryOne<{ status: string; attempts: number; quota_defers: number; scheduled_for: string }>(
        `SELECT status, attempts, quota_defers, scheduled_for FROM sync_tasks WHERE id = $1`, [hist!.id],
      );
      expect(row!.status).toBe('pending');
      expect(row!.attempts).toBe(0);
      expect(Number(row!.quota_defers)).toBe(1);
      expect(new Date(row!.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 60_000);

      const liveId = await enqueueTask({ taskKey: `test:rebuild:live:${Date.now()}`, taskType: 'live:sync', priority: 10 });
      await processTask((await claimTaskById(liveId))!);
      expect((await queryOne<{ status: string }>(`SELECT status FROM sync_tasks WHERE id = $1`, [liveId]))!.status).toBe('done');
    } finally {
      await quotaManager.observeExternal(0, s0.dailyLimit);
    }
    // make the deferred task due again for the drain below
    await query(`UPDATE sync_tasks SET scheduled_for = now() WHERE task_type = 'fixtures:import'`);
  });

  it('drains the one-time imports; afterwards nothing is re-queued and re-runs make no provider request', async () => {
    // quota usage accumulated by earlier test files must not defer this drain
    const { quotaManager } = await import('../src/sync/quota.js');
    const q = await quotaManager.status();
    await quotaManager.observeExternal(0, q.dailyLimit);
    await query(`UPDATE sync_tasks SET scheduled_for = now(), quota_defers = 0 WHERE task_type = 'fixtures:import' AND status = 'pending'`);
    await drainDueTasks(5000);
    const report = await buildImportScopeReport();
    expect(report.competitionSeasons.historicalImported).toBe(12);
    expect(report.competitionSeasons.historicalPending).toBe(0);
    expect(report.competitionSeasons.currentBootstrapped).toBe(4);
    expect(report.competitionSeasons.currentPending).toBe(0);
    expect(report.fixtures.outsideScope).toBe(0);
    expect(report.tasks.queuedOutOfScope).toBe(0);

    const again = await enqueueSeasonWindowTasks();
    expect(again.tasks).toBe(0);

    const comp = await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`);
    const s2026 = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = 2026`);
    const s2024 = await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = 2024`);
    const before = await providerRequests();
    const cur = await importFixturesForCompetitionSeason(comp!.id, s2026!.id, { fetchDetails: false });
    const hist = await importFixturesForCompetitionSeason(comp!.id, s2024!.id, { fetchDetails: false });
    expect(cur.alreadyImported).toBe(true); // no repeated full 2026 import
    expect(hist.alreadyImported).toBe(true); // 2023–2025 imported once
    expect(await providerRequests()).toBe(before);
  });

  it('2026 keeps synchronising: upcoming window by date and daily recent-finished reconciliation', async () => {
    const up = await syncUpcomingFixtures(7, 0);
    expect(up.requests).toBe(7);
    const recent = await syncUpcomingFixtures(0, 2);
    expect(recent.requests).toBe(2); // yesterday + the day before; today is covered by the upcoming window
  });

  it('restart recovery: tasks stranded in running are requeued; skipped orphans stay skipped', async () => {
    const liveId = await enqueueTask({ taskKey: `test:restart:live:${Date.now()}`, taskType: 'live:sync', priority: 10 });
    await query(`UPDATE sync_tasks SET status = 'running', started_at = now() - interval '10 minutes', attempts = 1 WHERE id = $1`, [liveId]);
    await query(
      `INSERT INTO sync_tasks (task_key, task_type, params, priority, status, attempts)
       VALUES ('teams:1363:18', 'teams:import', '{"competitionId":1363,"seasonId":18}', 45, 'pending', 3)`,
    );
    await skipOutOfScopeTasks();
    const requeued = await requeueStuckTasks(2);
    expect(requeued).toBeGreaterThanOrEqual(1);
    expect((await queryOne<{ status: string }>(`SELECT status FROM sync_tasks WHERE id = $1`, [liveId]))!.status).toBe('pending');
    expect((await getTaskByKey('teams:1363:18'))!.status).toBe('skipped');
    // the scheduler can never recreate it
    expect(await enqueueTask({ taskKey: 'teams:1363:18', taskType: 'teams:import', params: { competitionId: 1363, seasonId: 18 } })).toBe(0);
    expect((await getTaskByKey('teams:1363:18'))!.status).toBe('skipped');
    const report = await buildImportScopeReport();
    expect(report.tasks.queuedOutOfScope).toBe(0);
  });
});
