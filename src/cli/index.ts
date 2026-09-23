import { logger } from '../logger.js';
import { runMigrations } from '../db/migrate.js';
import { pool, query } from '../db/pool.js';
import { providerClient } from '../provider/client.js';
import { quotaManager } from '../provider/quota.js';
import { createJob, enqueueTask, failedTasks, retryFailedTasks, syncStats, finishTask } from '../sync/tasksDb.js';
import { taskHandlers, planHistoricalImport, importScope, currentSeasons, warmCacheForSeason, enqueueFixtureDetail } from '../sync/handlers.js';
import { executeTask } from '../sync/worker.js';
import { createApiKey, revokeApiKey, rotateApiKey } from '../keys/service.js';
import { runQualityChecks } from '../api/routes/health.js';
import { recalcLeagueStatistics } from '../analytics/league.js';
import { recalcTeamStatistics, updateStreaks } from '../analytics/team.js';
import { recalcPlayerSeasonStatistics } from '../analytics/player.js';
import { recalcRefereeMatchStats, recalcRefereeSeasonStats, recalcRefereeCompetitionStats } from '../analytics/referee.js';
import { rebuildUpcomingFeatures } from '../analytics/features.js';
import { cacheDelPattern, getRedis } from '../redis/client.js';
import { resolveCompetitionSeason, getCoverage } from '../repos/lookups.js';
import { upsertFixture, storeFixtureEvents, storeFixtureTeamStats, storeLineups, storePlayerMatchStats, storeStandings } from '../repos/fixtures.js';
import { mapFixture, mapEvents, mapTeamStats, mapLineups, mapPlayerMatchStats, mapStandings } from '../mapping/fixtures.js';
import type { AFLeague, AFFixtureResponse } from '../provider/types.js';
import type { SyncTask } from '../sync/tasksDb.js';
import { writeFileSync } from 'node:fs';

const log = logger.child({ mod: 'cli' });

// eslint-disable-next-line no-console
const out = console.log;

/** server/worker commands keep the process alive instead of exiting. */
let longRunning = false;

interface Args { [k: string]: string | boolean | undefined }

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function csv(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string' || !value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function runTaskInline(taskType: string, payload: Record<string, unknown>): Promise<unknown> {
  const handler = taskHandlers[taskType];
  if (!handler) throw new Error(`no handler for ${taskType}`);
  const task = {
    id: -1, job_id: null, task_type: taskType, status: 'running', priority: 5, attempts: 1, max_attempts: 1,
    scheduled_at: new Date(), payload, unique_key: null, last_error: null,
  } as unknown as SyncTask;
  try {
    const result = await handler(task);
    return result ?? {};
  } catch (err) {
    await finishTask(task, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case undefined:
    case 'help': {
      out(`Football Data Platform CLI

Usage: npm run cli -- <command> [options]

Setup & data
  database:migrate                 Run SQL migrations
  competitions:import              Import full competitions/seasons/coverage catalogue
  seasons:import                   Alias of competitions:import (provider returns both)
  historical:import [--details=N]  Plan + execute resumable import of previous N seasons + current
  current:sync                     Sync current season (upcoming/live/standings/features)
  competition:sync --league=ID [--season=YEAR]   Sync one competition (optionally one season)
  season:sync --season=YEAR        Sync all scoped competitions for a season year
  fixture:sync --id=PROVIDER_ID    Fetch + store one fixture with details
Statistics
  statistics:recalculate [--cs=INTERNAL_CS_ID]   Recalculate all analytics for a competition-season
  league:recalculate --league=PROVIDER_ID --season=YEAR
  team:recalculate --team=INTERNAL_TEAM_ID --league=P_ID --season=YEAR
  player:recalculate --player=INTERNAL_PLAYER_ID --league=P_ID --season=YEAR
  referee:recalculate              Rebuild referee match/season/competition stats
  prediction-features:rebuild      Rebuild features for upcoming fixtures
  cache:rebuild                    Warm Redis caches
Ops
  data-quality:check               Run data quality checks
  quota:status                     Show provider quota snapshot (+ live /status check)
  sync:failed [--retry]            List failed sync tasks; --retry requeues them
Keys & security
  api-key:create --client "Name" --scopes a,b [--expires-days=N]
  api-key:rotate --id=KEY_ID [--grace-hours=24]
  api-key:revoke --id=KEY_ID [--reason "..."]
  api-key:list
Services
  server                           Start the REST API
  worker                           Start sync worker + scheduler
`);
      return;
    }

    case 'database:migrate': {
      const res = await runMigrations();
      out(`✅ Applied ${res.applied.length} migration(s)${res.skipped.length ? `, ${res.skipped.length} already applied` : ''}`);
      for (const f of res.applied) out(`   + ${f}`);
      return;
    }

    case 'competitions:import':
    case 'seasons:import': {
      const result = await runTaskInline('import.leagues', {});
      out(`✅ Catalogue imported: ${JSON.stringify(result)}`);
      return;
    }

    case 'historical:import': {
      if (args.details) {
        process.env.HISTORICAL_DETAIL_SEASONS = String(args.details);
      }
      await runMigrations();
      const jobType = 'historical-import';
      const jobId = await createJob(jobType, { scope: await importScope() }, 3);
      const plan = await planHistoricalImport(jobId);
      out(`📋 Planned ${plan.tasks} bootstrap tasks (job ${jobId})`);
      const { runDueTasks } = await import('../sync/worker.js');
      let idle = 0;
      for (;;) {
        const r = await runDueTasks(4);
        if (r.claimed === 0) {
          idle++;
          if (idle >= 3) break;
          await new Promise((res) => setTimeout(res, 1500));
        } else {
          idle = 0;
        }
      }
      const stats = await syncStats();
      out(`✅ Import round finished. Task stats: ${JSON.stringify(stats)}`);
      return;
    }

    case 'current:sync': {
      for (const type of ['sync.upcoming', 'sync.standings', 'sync.finalize-pending', 'features.rebuild']) {
        await enqueueTask(type, {}, { priority: type === 'sync.upcoming' ? 7 : 5, uniqueKey: `cli:${type}:${Date.now()}` });
      }
      const { runDueTasks } = await import('../sync/worker.js');
      await runDueTasks(8);
      out('✅ Current-season sync round executed.');
      return;
    }

    case 'competition:sync': {
      const leagueId = Number(args.league);
      if (!leagueId) throw new Error('--league=PROVIDER_ID required');
      const seasonYear = args.season ? Number(args.season) : (await currentSeasons()).find((s) => s.leagueId === leagueId)?.seasonYear;
      if (!seasonYear) {
        // bootstrap from provider
        await runTaskInline('cs.bootstrap', { leagueId, seasonYear: Number(args.season ?? new Date().getUTCFullYear()), withDetail: true });
        out(`✅ Bootstrapped league ${leagueId} for season ${args.season ?? 'current'}`);
        return;
      }
      for (const type of ['cs.fixtures', 'cs.teams', 'cs.standings', 'cs.stats']) {
        await runTaskInline(type, { leagueId, seasonYear, competitionSeasonId: (await resolveCompetitionSeason(leagueId, seasonYear))?.competitionSeasonId });
      }
      out(`✅ Synced league ${leagueId} season ${seasonYear}`);
      return;
    }

    case 'season:sync': {
      const year = Number(args.season);
      if (!year) throw new Error('--season=YEAR required');
      const scope = await importScope();
      for (const leagueId of scope.leagueIds) {
        await runTaskInline('cs.bootstrap', { leagueId, seasonYear: year, withDetail: true }).catch((e) => out(`⚠️ league ${leagueId}: ${e.message}`));
      }
      out(`✅ Season ${year} sync queued for ${scope.leagueIds.length} competitions`);
      return;
    }

    case 'fixture:sync': {
      const id = Number(args.id);
      if (!id) throw new Error('--id=PROVIDER_FIXTURE_ID required');
      const res = await providerClient.get('fixtures', { id }, { priority: 'high', rawEntityType: 'fixture' });
      const f = (res.envelope.response as AFFixtureResponse[])[0];
      if (!f) throw new Error(`fixture ${id} not found at provider`);
      const row = mapFixture(f);
      const { id: internalId } = await upsertFixture(row);
      const cs = await resolveCompetitionSeason(row.competitionProviderId, row.seasonYear);
      const coverage = cs ? await getCoverage(cs.competitionSeasonId) : null;
      const p = { id };
      if (coverage?.events) await storeFixtureEvents(internalId, mapEvents(id, ((await providerClient.get('fixtures/events', p, { priority: 'medium' })).envelope.response) as never));
      if (coverage?.fixtureStatistics) await storeFixtureTeamStats(internalId, mapTeamStats(((await providerClient.get('fixtures/statistics', p, { priority: 'medium' })).envelope.response) as never));
      if (coverage?.lineups) await storeLineups(internalId, mapLineups(((await providerClient.get('fixtures/lineups', p, { priority: 'medium' })).envelope.response) as never));
      if (coverage?.playerStatistics) await storePlayerMatchStats(internalId, mapPlayerMatchStats(((await providerClient.get('fixtures/players', p, { priority: 'medium' })).envelope.response) as never), { competitionSeasonId: cs?.competitionSeasonId });
      out(`✅ Fixture ${id} synced as internal fixture ${internalId}`);
      return;
    }

    case 'statistics:recalculate': {
      const csId = args.cs ? Number(args.cs) : null;
      const current = await currentSeasons();
      const seasons = csId ? [csId] : (await Promise.all(current.map((s) => resolveCompetitionSeason(s.leagueId, s.seasonYear)))).filter(Boolean).map((r) => r!.competitionSeasonId);
      for (const cs of seasons) {
        await recalcLeagueStatistics(cs);
        await recalcTeamStatistics(cs);
        await updateStreaks(cs);
        await recalcPlayerSeasonStatistics(cs);
        await recalcRefereeMatchStats(cs);
        await recalcRefereeSeasonStats(cs);
      }
      await recalcRefereeCompetitionStats();
      out(`✅ Recalculated statistics for ${seasons.length} competition-season(s)`);
      return;
    }

    case 'league:recalculate': {
      const leagueId = Number(args.league);
      const year = Number(args.season);
      if (!leagueId || !year) throw new Error('--league=PROVIDER_ID --season=YEAR required');
      const cs = await resolveCompetitionSeason(leagueId, year);
      if (!cs) throw new Error('competition-season not imported yet');
      await recalcLeagueStatistics(cs.competitionSeasonId);
      out(`✅ League statistics recalculated (cs ${cs.competitionSeasonId})`);
      return;
    }

    case 'team:recalculate': {
      const teamId = Number(args.team);
      const csId = args.cs ? Number(args.cs) : (await resolveCompetitionSeason(Number(args.league), Number(args.season)))?.competitionSeasonId;
      if (!teamId || !csId) throw new Error('--team=ID and (--cs=CS_ID or --league --season) required');
      await recalcTeamStatistics(csId, teamId);
      out(`✅ Team statistics recalculated`);
      return;
    }

    case 'player:recalculate': {
      const playerId = Number(args.player);
      const csId = args.cs ? Number(args.cs) : (await resolveCompetitionSeason(Number(args.league), Number(args.season)))?.competitionSeasonId;
      if (!playerId || !csId) throw new Error('--player=ID and (--cs=CS_ID or --league --season) required');
      await recalcPlayerSeasonStatistics(csId, playerId);
      out(`✅ Player statistics recalculated`);
      return;
    }

    case 'referee:recalculate': {
      const csId = args.cs ? Number(args.cs) : undefined;
      await recalcRefereeMatchStats(csId);
      await recalcRefereeSeasonStats(csId);
      await recalcRefereeCompetitionStats();
      out('✅ Referee statistics recalculated');
      return;
    }

    case 'prediction-features:rebuild': {
      const n = await rebuildUpcomingFeatures(args.cs ? Number(args.cs) : undefined);
      out(`✅ Rebuilt ${n} prediction feature sets`);
      return;
    }

    case 'cache:rebuild': {
      const current = await currentSeasons();
      for (const s of current) {
        const cs = await resolveCompetitionSeason(s.leagueId, s.seasonYear);
        if (cs) await warmCacheForSeason(cs.competitionSeasonId);
      }
      out(`✅ Cache warmed for ${current.length} current competition-season(s)`);
      return;
    }

    case 'data-quality:check': {
      const results = await runQualityChecks();
      let failures = 0;
      for (const r of results) {
        const icon = r.violations === 0 ? '✅' : '❌';
        if (r.violations !== 0) failures++;
        out(`${icon} ${r.check}: violations=${r.violations}${r.sample ? ` (${JSON.stringify(r.sample)})` : ''}`);
      }
      const stats = await syncStats();
      out(`\nSync tasks: ${JSON.stringify(stats)}`);
      if (failures > 0) process.exitCode = 1;
      return;
    }

    case 'quota:status': {
      const live = args.live ? await providerClient.checkStatus() : null;
      const snap = await quotaManager.snapshot();
      out(`Provider quota (level: ${snap.level})`);
      out(`  daily:   ${snap.dailyUsed}/${snap.dailyLimit} used, ${snap.dailyRemaining} remaining`);
      out(`  minute:  ${snap.minuteUsed}/${snap.minuteLimit} used, ${snap.minuteRemaining} remaining`);
      out(`  source:  ${snap.source}, updated: ${snap.lastUpdated ?? 'never'}`);
      if (live) out(`  live /status: ${live.message}`);
      return;
    }

    case 'sync:failed': {
      if (args.retry) {
        const n = await retryFailedTasks();
        out(`✅ Requeued ${n} failed task(s)`);
        return;
      }
      const failed = await failedTasks(Number(args.limit ?? 50));
      if (!failed.length) {
        out('No failed tasks 🎉');
        return;
      }
      for (const t of failed) {
        out(`#${t.id} [${t.task_type}] attempts=${t.attempts}/${t.max_attempts} payload=${JSON.stringify(t.payload)}`);
        out(`   error: ${t.last_error?.slice(0, 300)}`);
      }
      const stats = await syncStats();
      out(`\nTotals: ${JSON.stringify(stats)}`);
      return;
    }

    case 'api-key:create': {
      const clientName = String(args.client ?? '');
      if (!clientName) throw new Error('--client "Client Name" required');
      const scopes = csv(args.scopes);
      if (!scopes.length) throw new Error(`--scopes required (e.g. --scopes "fixtures:read,teams:read,standings:read,statistics:read,predictions:read")`);
      let clientId = (
        await query<{ id: number }>(`SELECT id FROM api_clients WHERE lower(name) = lower($1)`, [clientName])
      ).rows[0]?.id;
      if (!clientId) {
        clientId = (
          await query<{ id: number }>(
            `INSERT INTO api_clients (name, description, client_type) VALUES ($1, $2, $3) RETURNING id`,
            [clientName, `Created via CLI`, args.type ? String(args.type) : 'other'],
          )
        ).rows[0].id;
        out(`(created new client "${clientName}" #${clientId})`);
      }
      const created = await createApiKey({
        clientId,
        scopes,
        expiresInDays: args['expires-days'] ? Number(args['expires-days']) : undefined,
      });
      out(`Client:  ${clientName}`);
      out(`Key ID:  ${created.keyId}`);
      out(`Scopes:  ${created.scopes.join(', ')}`);
      out(`API Key:`);
      out(`${created.fullKey}`);
      out('');
      out('IMPORTANT: Save this key now. It will not be displayed again.');
      return;
    }

    case 'api-key:rotate': {
      const id = Number(args.id);
      if (!id) throw new Error('--id=KEY_ID required');
      const graceHours = args['grace-hours'] ? Number(args['grace-hours']) : 24;
      const created = await rotateApiKey(id, graceHours);
      out(`New key created (ID ${created.keyId}); old key valid for ${graceHours}h grace.`);
      out(`API Key:`);
      out(`${created.fullKey}`);
      out('');
      out('IMPORTANT: Save this key now. It will not be displayed again.');
      return;
    }

    case 'api-key:revoke': {
      const id = Number(args.id);
      if (!id) throw new Error('--id=KEY_ID required');
      await revokeApiKey(id, args.reason ? String(args.reason) : 'manual revocation via CLI');
      out(`✅ Key ${id} revoked immediately.`);
      return;
    }

    case 'api-key:list': {
      const { rows } = await query<Record<string, unknown>>(
        `SELECT k.id, c.name AS client, k.key_prefix, k.scopes, k.created_at, k.last_used_at, k.expires_at, k.revoked_at
         FROM api_keys k JOIN api_clients c ON c.id = k.client_id ORDER BY k.id DESC LIMIT 200`,
      );
      for (const r of rows) {
        out(`#${r.id} ${String(r.client).padEnd(20)} ${String(r.key_prefix)}…  scopes=${(r.scopes as string[]).join(',')}${r.revoked_at ? '  REVOKED' : ''}${r.expires_at ? '  expires=' + new Date(String(r.expires_at)).toISOString().slice(0, 10) : ''}`);
      }
      if (!rows.length) out('(no keys yet — create one with api-key:create)');
      return;
    }

    case 'server': {
      const { startApi } = await import('../api/server.js');
      await startApi();
      longRunning = true; // keep process alive
      return;
    }

    case 'worker': {
      const { startWorkerLoop } = await import('../sync/worker.js');
      const { startScheduler } = await import('../sync/scheduler.js');
      await startScheduler();
      await startWorkerLoop();
      longRunning = true;
      return;
    }

    case 'swagger:export': {
      const { buildApp } = await import('../api/server.js');
      const app = await buildApp();
      await app.ready();
      const spec = app.swagger();
      writeFileSync('openapi.json', JSON.stringify(spec, null, 2));
      await app.close();
      out('✅ OpenAPI spec exported to openapi.json (also served at /docs/json)');
      return;
    }

    default:
      throw new Error(`unknown command: ${command} (try 'help')`);
  }
}

main()
  .then(() => {
    if (longRunning) return; // server/worker keep running
    const redis = getRedis();
    if (redis) void redis.quit().catch(() => {});
    return pool.end().then(() => process.exit(0));
  })
  .catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, `command failed`);
    // eslint-disable-next-line no-console
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    pool.end().finally(() => process.exit(1));
  });
