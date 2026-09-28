import { runCli, bootstrap } from './common.js';

/**
 * Quota status + reconciliation. In live mode the provider's own /status
 * counters are fetched first (management endpoint — quota-free and exempt
 * from deferral) and override local counting, so this works even when the
 * local state says CRITICAL/EXHAUSTED.
 */
runCli(async () => {
  await bootstrap({ handlers: false });
  const { quotaManager } = await import('../sync/quota.js');
  const { config } = await import('../config.js');
  const { query } = await import('../lib/db.js');

  const before = await quotaManager.status();
  let reconciliation: unknown = null;
  if (config.providerMode === 'live') {
    const { reconcileQuota } = await import('../sync/quota-reconcile.js');
    reconciliation = await reconcileQuota();
  }
  const after = await quotaManager.status();
  const recent = await query(
    `SELECT endpoint, count(*) AS calls, sum((success IS NOT TRUE)::int) AS failures
       FROM provider_requests WHERE started_at > now() - interval '24 hours'
      GROUP BY endpoint ORDER BY calls DESC LIMIT 20`,
  );
  return {
    quotaBefore: before,
    reconciledFromProvider: reconciliation,
    quota: after,
    policy: {
      dailyLimit: after.dailyLimit,
      essentialReserve: after.essentialReserve,
      backgroundFloor: after.backgroundFloor,
      essentialKeepsRunning: ['live:sync', 'upcoming:sync', 'current:sync', 'postmatch:scan', 'fixture:postmatch', 'fixture:details'],
    },
    providerMode: config.providerMode,
    recent,
  };
});
