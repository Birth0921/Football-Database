import { runCli, bootstrap, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap({ handlers: false });
  const tasks = await import('../sync/tasks.js');
  if (args.retry) {
    const keys = args.task ? [String(args.task)] : undefined;
    const retried = await tasks.retryFailedTasks(keys);
    return { retried };
  }
  const failed = await tasks.listFailedTasks(Number(args.limit ?? 50));
  return { failed, summary: await tasks.syncSummary() };
});
