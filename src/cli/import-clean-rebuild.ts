/**
 * npm run import:clean-rebuild
 *
 * Starts the clean approved import (run AFTER db:reset-imported-data, with the
 * worker + scheduler running). Idempotent — safe to run again:
 *   1. approved Tier 1–3 catalogue (1 provider request) → competitions,
 *      seasons 2023–2026, competition/season pairs; out-of-scope rows disabled
 *   2. stale out-of-scope queue rows marked skipped
 *   3. 2026 current sync now: live + today/upcoming (7 days) + post-match
 *   4. one-time imports queued as quota-gated BACKGROUND work:
 *        2026 season bootstrap (priority 35) and 2023–2025 historical (55);
 *      already-imported pairs are never queued again
 * The worker processes step 4 by priority; live/current work always first.
 */
import { runCli, bootstrap, runTaskOnce } from './common.js';

runCli(async () => {
  await bootstrap();
  const { importCompetitions, enqueueSeasonWindowTasks } = await import('../sync/pipelines/metadata.js');
  const { skipOutOfScopeTasks } = await import('../sync/scope-guard.js');
  const { buildImportScopeReport } = await import('../maintenance/import-report.js');

  const catalogue = await importCompetitions();
  const staleTasks = await skipOutOfScopeTasks();
  const current = await runTaskOnce('current:sync', {}, `cli:clean-rebuild:current:${Date.now()}`);
  const queued = await enqueueSeasonWindowTasks();
  const report = await buildImportScopeReport();
  return { catalogue, staleTasksSkipped: staleTasks.skipped, currentSync: current, oneTimeImportsQueued: queued, report };
});
