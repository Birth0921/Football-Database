/**
 * Bulk-finalize backfill: run the post-match pipeline for all completed but
 * non-finalized fixtures (idempotent — already finalized fixtures are skipped).
 * Usage: npx tsx scripts/bulk-finalize.ts [--limit 5000]
 */
import { runCli, bootstrap, parseArgs } from '../src/cli/common.js';
import { drainDueTasks } from '../src/sync/engine.js';
import { enqueueTask, upsertJob } from '../src/sync/tasks.js';
import { query } from '../src/lib/db.js';

const args = parseArgs();
runCli(async () => {
  await bootstrap();
  const limit = Number(args.limit ?? 5000);
  const jobId = await upsertJob(`postmatch:bulk:${Date.now()}`, 'postmatch', {}, 10);
  const rows = await query<{ id: number }>(
    `SELECT id FROM fixtures WHERE finalized = FALSE AND status_short IN ('FT','AET','PEN')`,
  );
  for (const r of rows) {
    await enqueueTask({
      taskKey: `postmatch:${r.id}`,
      taskType: 'fixture:postmatch',
      params: { fixtureId: r.id },
      priority: 25,
      jobId,
    });
  }
  const drained = await drainDueTasks(limit);
  return { enqueued: rows.length, drained };
});
