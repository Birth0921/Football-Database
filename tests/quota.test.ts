/**
 * Quota policy tests: tier semantics (the 29,355/150,000 scenario must defer
 * background work but NEVER essential fixture sync), class-aware gating,
 * provider-authoritative reconciliation, and deferral backoff.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closePool, query } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { quotaManager, taskClassFor } from '../src/sync/quota.js';
import { config } from '../src/config.js';

beforeAll(async () => {
  await quotaManager.ensureToday();
});

afterAll(async () => {
  // leave the row NORMAL for subsequent test files
  await quotaManager.observeExternal(0, config.providerDailyQuota);
  await closeRedis();
  await closePool();
});

describe('quota tiers (production scenario)', () => {
  it('classifies ~29,355 of 150,000 remaining as CAUTION — not a stop condition', () => {
    // exact production numbers: background defers, essentials keep running
    expect(quotaManager.stateFor(29_355, 150_000)).toBe('CAUTION');
    const t = quotaManager.thresholds(150_000);
    expect(t.essentialReserve).toBe(10_000);
    expect(t.backgroundFloor).toBe(30_000);
    expect(29_355).toBeLessThanOrEqual(t.backgroundFloor); // why background defers
    expect(29_355).toBeGreaterThan(t.essentialReserve); // why essentials continue
  });

  it('keeps the configured daily limit of 150,000 untouched', () => {
    // config limit is the authority for thresholds; provider limit only
    // reconciles remaining/used when the provider reports it
    expect(quotaManager.stateFor(150_000, 150_000)).toBe('NORMAL');
    expect(quotaManager.stateFor(120_000, 150_000)).toBe('NORMAL');
  });

  it('escalates: CAUTION (background pauses) → CRITICAL (essentials only) → EXHAUSTED (all stop)', () => {
    expect(quotaManager.stateFor(25_000, 150_000)).toBe('CAUTION');
    expect(quotaManager.stateFor(9_999, 150_000)).toBe('CRITICAL');
    expect(quotaManager.stateFor(0, 150_000)).toBe('EXHAUSTED');
    expect(quotaManager.stateFor(-5, 150_000)).toBe('EXHAUSTED');
  });

  it('classifies task types: fixture sync is essential, imports/metadata are background', () => {
    for (const t of ['live:sync', 'upcoming:sync', 'current:sync', 'postmatch:scan', 'fixture:postmatch', 'fixture:details']) {
      expect(taskClassFor(t)).toBe('essential');
    }
    for (const t of ['coverage:discover', 'teams:import', 'standings:sync', 'fixtures:import', 'historical:import', 'injuries:sync', 'odds:sync', 'season-window:enqueue', 'stats:recalculate:all', undefined, null]) {
      expect(taskClassFor(t as string | undefined)).toBe('background');
    }
  });
});

describe('class-aware gating (DB-backed, configured limit)', () => {
  it('CAUTION: background deferred, essential allowed', async () => {
    const s = await quotaManager.status();
    // remaining just below the background floor, above the essential reserve
    const remaining = Math.max(s.essentialReserve + 1, s.backgroundFloor - 500);
    await quotaManager.observeExternal(s.dailyLimit - remaining, s.dailyLimit);
    const bg = await quotaManager.allows('teams:import');
    expect(bg.allowed).toBe(false);
    expect(bg.state).toBe('CAUTION');
    const essential = await quotaManager.allows('live:sync');
    expect(essential.allowed).toBe(true); // fixture sync NEVER stops in CAUTION
    const upcoming = await quotaManager.allows('upcoming:sync');
    expect(upcoming.allowed).toBe(true);
  });

  it('CRITICAL: essentials still run (that is what the reserve is for); background stays deferred', async () => {
    const s = await quotaManager.status();
    await quotaManager.observeExternal(s.dailyLimit - Math.max(1, s.essentialReserve - 1), s.dailyLimit);
    const essential = await quotaManager.allows('live:sync');
    expect(essential.state).toBe('CRITICAL');
    expect(essential.allowed).toBe(true);
    expect((await quotaManager.allows('historical:import')).allowed).toBe(false);
  });

  it('EXHAUSTED: everything stops (never bypass the provider limit)', async () => {
    const s = await quotaManager.status();
    await quotaManager.observeExternal(s.dailyLimit, s.dailyLimit); // 0 remaining
    expect((await quotaManager.allows('live:sync')).allowed).toBe(false);
    expect((await quotaManager.allows('upcoming:sync')).allowed).toBe(false);
    expect((await quotaManager.allows('teams:import')).allowed).toBe(false);
  });

  it('NORMAL: everything allowed', async () => {
    await quotaManager.observeExternal(0, config.providerDailyQuota);
    expect((await quotaManager.allows('live:sync')).allowed).toBe(true);
    expect((await quotaManager.allows('teams:import')).allowed).toBe(true);
  });
});

describe('provider-authoritative reconciliation', () => {
  it('observeExternal overrides local counting with provider numbers', async () => {
    // provider says 120,645 of 150,000 used → 29,355 remaining (CAUTION)
    const status = await quotaManager.observeExternal(120_645, 150_000);
    expect(status.dailyRemaining).toBe(29_355);
    expect(status.dailyUsed).toBe(120_645);
    expect(status.state).toBe('CAUTION');
    expect(status.reconciledAt).toBeTruthy();
    // reconciliation works even from a CRITICAL/EXHAUSTED local state:
    await quotaManager.observeExternal(config.providerDailyQuota, config.providerDailyQuota); // local says EXHAUSTED
    expect((await quotaManager.status()).state).toBe('EXHAUSTED');
    const healed = await quotaManager.observeExternal(10_000, 150_000); // provider disagrees
    expect(healed.state).toBe('NORMAL'); // local EXHAUSTED corrected by authoritative counters
    expect(healed.dailyRemaining).toBe(140_000);
  });

  it('recordUse treats provider header values as authoritative', async () => {
    await quotaManager.observeExternal(0, 150_000);
    await quotaManager.recordUse(29_355, null); // header override
    const s = await quotaManager.status();
    expect(s.dailyRemaining).toBe(29_355);
    expect(s.state).toBe('CAUTION');
    await quotaManager.recordUse(); // no header → local decrement from 29,355
    expect((await quotaManager.status()).dailyRemaining).toBe(29_354);
  });
});

describe('deferral backoff', () => {
  it('grows exponentially and caps at one hour', () => {
    const first = quotaManager.deferDelaySeconds(0);
    const second = quotaManager.deferDelaySeconds(1);
    const third = quotaManager.deferDelaySeconds(2);
    const capped = quotaManager.deferDelaySeconds(20);
    expect(first).toBeGreaterThanOrEqual(300);
    expect(first).toBeLessThanOrEqual(360);
    expect(second).toBeGreaterThanOrEqual(600);
    expect(second).toBeLessThanOrEqual(660);
    expect(third).toBeGreaterThanOrEqual(1200);
    expect(capped).toBeLessThanOrEqual(3660);
  });
});
