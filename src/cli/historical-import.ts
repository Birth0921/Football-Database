import { runCli, bootstrap, runTaskOnce } from './common.js';
runCli(async () => {
  await bootstrap();
  // Kick off the resumable import queue, then drain as much as fits this run.
  const enqueued = await runTaskOnce('historical:import', {});
  const { drainDueTasks } = await import('../sync/engine.js');
  const drained = await drainDueTasks(Number(process.env.IMPORT_TASK_BUDGET ?? 500));
  return { enqueued, drained };
});
