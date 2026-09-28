/** Shared CLI helpers. */
import { registerAllHandlers } from '../sync/handlers.js';
import { runMigrations } from '../lib/migrate.js';
import { closePool, queryOne } from '../lib/db.js';
import { closeRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { drainDueTasks } from '../sync/engine.js';
import { enqueueTask, upsertJob } from '../sync/tasks.js';

export interface CliArgs {
  _: string[];
  [key: string]: string | boolean | string[];
}

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const out: CliArgs = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) out[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out[key] = argv[++i];
      } else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

export async function bootstrap(opts: { handlers?: boolean; migrate?: boolean } = {}): Promise<void> {
  if (opts.handlers !== false) registerAllHandlers();
  if (opts.migrate) await runMigrations();
  const row = await queryOne<{ one: number }>('SELECT 1 AS one');
  if (!row) throw new Error('database unavailable');
}

export async function shutdown(): Promise<void> {
  await closeRedis();
  await closePool();
}

export async function runCli(fn: (args: CliArgs) => Promise<unknown>): Promise<void> {
  const args = parseArgs();
  try {
    const result = await fn(args);
    if (result !== undefined) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    await shutdown();
    process.exit(0);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'command failed');
    process.stderr.write(`ERROR: ${(err as Error).message}\n`);
    await shutdown().catch(() => undefined);
    process.exit(1);
  }
}

/** Enqueue a one-off task and execute it synchronously (for CLI commands). */
export async function runTaskOnce(taskType: string, params: Record<string, unknown> = {}, taskKey = `cli:${taskType}:${Date.now()}`): Promise<unknown> {
  await upsertJob(taskKey, 'cli', params, 5);
  const taskId = await enqueueTask({ taskKey, taskType, params, priority: 1, maxAttempts: 3 });
  if (!taskId) {
    throw new Error(`task ${taskType} rejected: competition/season or fixture is missing or outside the approved import scope`);
  }
  const { processTask } = await import('../sync/engine.js');
  const { getTaskByKey, claimTaskById } = await import('../sync/tasks.js');
  const claimed = await claimTaskById(taskId);
  if (!claimed) {
    const existing = await getTaskByKey(taskKey);
    if (existing?.status === 'done') return existing.result_summary ?? {};
    throw new Error(`task ${taskType} could not be claimed (status=${existing?.status ?? 'unknown'})`);
  }
  const ok = await processTask(claimed);
  const t = await getTaskByKey(taskKey);
  if (!ok && t?.status !== 'done') throw new Error(`task ${taskType} did not complete: ${t?.last_error ?? 'unknown error'}`);
  return t?.result_summary ?? {};
}

export { runMigrations };
