/**
 * Reconcile the local quota state with the provider's own counters.
 *
 * Uses the provider /status endpoint — a management endpoint that does not
 * consume daily quota and is exempt from quota deferral — so reconciliation
 * works even when the local state says CRITICAL or EXHAUSTED. Values come
 * straight from the provider response; nothing is fabricated.
 */
import { getProvider } from '../provider/client.js';
import { quotaManager } from './quota.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export interface ReconcileResult {
  ok: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
  state?: string;
  error?: string;
}

export async function reconcileQuota(): Promise<ReconcileResult> {
  if (config.providerMode !== 'live') {
    return { ok: false, error: 'reconciliation requires live provider mode' };
  }
  try {
    const provider = await getProvider();
    const res = await provider.get<{ requests?: { current?: number; limit_day?: number } }>('/status', {});
    const item = (res.data.response as Array<{ requests?: { current?: number; limit_day?: number } }> | undefined)?.[0];
    const current = item?.requests?.current;
    if (typeof current !== 'number') {
      return { ok: false, error: 'provider /status did not include request counters' };
    }
    const limitDay = typeof item?.requests?.limit_day === 'number' ? item!.requests!.limit_day : null;
    const status = await quotaManager.observeExternal(current, limitDay);
    logger.info({ used: status.dailyUsed, remaining: status.dailyRemaining, state: status.state }, 'provider quota reconciled from /status');
    return { ok: true, used: status.dailyUsed, limit: status.dailyLimit, remaining: status.dailyRemaining, state: status.state };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'quota reconciliation failed');
    return { ok: false, error: (err as Error).message };
  }
}
