import { runCli, bootstrap, runTaskOnce } from './common.js';
runCli(async (args) => {
  await bootstrap();
  const result = await runTaskOnce('current:sync', { daysAhead: args.days ? Number(args.days) : 7 });
  const { drainDueTasks } = await import('../sync/engine.js');
  const drained = await drainDueTasks(Number(process.env.SYNC_TASK_BUDGET ?? 200));
  return { result, drained };
});
