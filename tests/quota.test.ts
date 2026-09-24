/** Quota manager tests: tracking, thresholds, priority deferral. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QuotaManager } from '../src/sync/quota.js';
import { closePool, query } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { config } from '../src/config.js';

beforeAll(async () => {
  // isolate: use a distinct provider key namespace via direct manipulation
  await query(`DELETE FROM provider_quota WHERE provider = 'api-football'`);
});
afterAll(async () => {
  // restore healthy quota so later suites can call the provider
  await query(
    `UPDATE provider_quota SET daily_used = 0, daily_remaining = daily_limit, minute_used = 0, minute_remaining = minute_limit,
            state = 'NORMAL' WHERE provider = 'api-football'`,
  );
  await closeRedis();
  await closePool();
});

describe('QuotaManager', () => {
  it('tracks daily and minute usage', async () => {
    const qm = new QuotaManager();
    await qm.ensureToday();
    const before = await qm.status();
    await qm.recordUse(null, null);
    await qm.recordUse(null, null);
    const after = await qm.status();
    expect(after.dailyUsed).toBe(before.dailyUsed + 2);
    expect(after.dailyRemaining).toBe(Math.max(before.dailyRemaining - 2, 0));
  });

  it('classifies NORMAL / CAUTION / CRITICAL states', async () => {
    const qm = new QuotaManager();
    const s = await qm.status();
    expect(s.state).toBe('NORMAL');

    // simulate 60% used → CAUTION
    await query(
      `UPDATE provider_quota SET daily_used = $1, daily_remaining = $2 WHERE provider = 'api-football' AND day = (now() AT TIME ZONE 'utc')::date`,
      [Math.floor(config.providerDailyQuota * 0.6), Math.floor(config.providerDailyQuota * 0.4)],
    );
    let st = await qm.status();
    expect(st.state).toBe('CAUTION');

    // 85% used → CRITICAL
    await query(
      `UPDATE provider_quota SET daily_used = $1, daily_remaining = $2 WHERE provider = 'api-football' AND day = (now() AT TIME ZONE 'utc')::date`,
      [Math.floor(config.providerDailyQuota * 0.85), Math.floor(config.providerDailyQuota * 0.15)],
    );
    st = await qm.status();
    expect(st.state).toBe('CRITICAL');

    // critical: defer low-priority work, keep live/important work
    expect(await qm.shouldDefer(10)).toBe(false); // live sync
    expect(await qm.shouldDefer(30)).toBe(false); // post-match
    expect(await qm.shouldDefer(90)).toBe(true); // historical refresh
  });

  it('adopts provider-reported counters', async () => {
    const qm = new QuotaManager();
    await qm.observeExternal(100, config.providerDailyQuota);
    const st = await qm.status();
    expect(st.dailyUsed).toBe(100);
    expect(st.dailyRemaining).toBe(config.providerDailyQuota - 100);
    expect(st.state).toBe('NORMAL');
  });

  it('blocks when quota is exhausted', async () => {
    const qm = new QuotaManager();
    await qm.observeExternal(config.providerDailyQuota, config.providerDailyQuota);
    expect(await qm.hasQuota()).toBe(false);
  });
});
