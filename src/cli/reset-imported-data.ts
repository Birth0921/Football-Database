/**
 * npm run db:reset-imported-data                      → DRY RUN (counts only)
 * npm run db:reset-imported-data -- --confirm reset-imported-football-data
 *                                                     → execute (non-production)
 * NODE_ENV=production additionally requires --production.
 *
 * Deletes ONLY imported football data + import/queue state. Never drops the
 * database/schema, never touches API keys/clients, managed website key,
 * audit/usage logs, migrations, the provider quota ledger, .env or Redis
 * configuration. Stop the worker and scheduler before executing.
 */
import { runCli, bootstrap } from './common.js';
import { RESET_CONFIRM_PHRASE, resetImportedData } from '../maintenance/reset-imported-data.js';

runCli(async (args) => {
  await bootstrap({ handlers: false });
  const confirm = typeof args.confirm === 'string' ? args.confirm : undefined;
  if (args.confirm !== undefined && confirm !== RESET_CONFIRM_PHRASE) {
    throw new Error(`--confirm must be exactly "${RESET_CONFIRM_PHRASE}"`);
  }
  const result = await resetImportedData({
    confirm,
    production: args.production === true,
    lockTimeoutMs: args['lock-timeout-ms'] ? Number(args['lock-timeout-ms']) : undefined,
  });
  const nonZero = (rows: { table: string; rows: number }[]) =>
    Object.fromEntries(rows.filter((r) => r.rows > 0).map((r) => [r.table, r.rows]));
  if (result.mode === 'dry-run') {
    return {
      mode: 'dry-run',
      wouldDeleteRows: result.totalRows,
      wouldDeleteByTable: nonZero(result.tables),
      protectedTablesUntouched: Object.fromEntries(result.protectedTables.map((r) => [r.table, r.rows])),
      next: `re-run with: -- --confirm ${RESET_CONFIRM_PHRASE}${process.env.NODE_ENV === 'production' ? ' --production' : ''}`,
    };
  }
  return {
    mode: 'executed',
    deletedRows: result.totalDeleted,
    deletedByTable: nonZero(result.deleted),
    protectedTablesUnchanged: result.protectedUnchanged,
    protectedTableRowCounts: Object.fromEntries(result.protectedTables.map((r) => [r.table, r.rows])),
    footballCacheCleared: result.cacheCleared,
    staleQueueJobsDrained: result.queueDrained,
    durationMs: result.durationMs,
  };
});
