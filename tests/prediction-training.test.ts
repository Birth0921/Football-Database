/**
 * Tests for the training side of the prediction-app example
 * (`examples/prediction-app/src/training`).
 *
 *  - the point-in-time dataset must never leak the match it describes
 *  - the read-only guard must refuse a connection that can write
 *  - the Poisson fitter must recover known team strengths, and beat a
 *    league-average baseline when the data actually contains signal
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query, closePool } from '../src/lib/db.js';
import {
  assertReadOnly,
  fetchPointInTimeDataset,
  type TrainingMatch,
} from '../examples/prediction-app/src/training/dataset.js';
import { evaluate, fitCompetition } from '../examples/prediction-app/src/training/fit.js';

// ---------------------------------------------------------------------------
// deterministic PRNG (same algorithm as the platform mock provider)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd: () => number): number {
  // Box–Muller
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poissonSample(rnd: () => number, lambda: number): number {
  // Knuth
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rnd();
  } while (p > limit && k < 20);
  return k - 1;
}

interface Simulated {
  matches: TrainingMatch[];
  trueAttack: Map<number, number>;
  trueDefence: Map<number, number>;
  mu: number;
  home: number;
}

/** Simulate a double round-robin league where team strengths are known. */
function simulate(options: { teams?: number; seasons?: number; seed?: number } = {}): Simulated {
  const teams = options.teams ?? 12;
  const seasons = options.seasons ?? 3;
  const rnd = mulberry32(options.seed ?? 42);
  const trueAttack = new Map<number, number>();
  const trueDefence = new Map<number, number>();
  for (let id = 1; id <= teams; id += 1) {
    trueAttack.set(id, gaussian(rnd) * 0.35);
    trueDefence.set(id, gaussian(rnd) * 0.35);
  }
  const mu = Math.log(1.25);
  const home = Math.log(1.35);

  const matches: TrainingMatch[] = [];
  let fixtureId = 1;
  for (let season = 1; season <= seasons; season += 1) {
    for (let h = 1; h <= teams; h += 1) {
      for (let a = 1; a <= teams; a += 1) {
        if (h === a) continue;
        const lambdaHome = Math.exp(mu + home + (trueAttack.get(h) ?? 0) + (trueDefence.get(a) ?? 0));
        const lambdaAway = Math.exp(mu + (trueAttack.get(a) ?? 0) + (trueDefence.get(h) ?? 0));
        matches.push({
          fixtureId: fixtureId++,
          competitionId: 1,
          seasonId: season,
          homeTeamId: h,
          awayTeamId: a,
          kickoffUtc: new Date(Date.UTC(2020 + season, 0, 1) + matches.length * 3_600_000),
          homeGoals: poissonSample(rnd, lambdaHome),
          awayGoals: poissonSample(rnd, lambdaAway),
        });
      }
    }
  }
  return { matches, trueAttack, trueDefence, mu, home };
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

// ---------------------------------------------------------------------------
// database fixtures for the leakage test
// ---------------------------------------------------------------------------
let competitionId = 0;
let seasonId = 0;
let homeTeamId = 0;
let awayTeamId = 0;

beforeAll(async () => {
  const comp = await query<{ id: number }>(
    `INSERT INTO competitions (name, provider_id, type) VALUES ('Leakage Test FC League', 'leak-test-1', 'League') RETURNING id`,
  );
  competitionId = Number(comp[0].id);
  const season = await query<{ id: number }>(
    `INSERT INTO seasons (year, display_name, provider_id) VALUES (2090, '2090/91', 'leak-season-1') RETURNING id`,
  );
  seasonId = Number(season[0].id);
  const home = await query<{ id: number }>(`INSERT INTO teams (name, provider_id) VALUES ('Leakage Home', 'leak-home') RETURNING id`);
  const away = await query<{ id: number }>(`INSERT INTO teams (name, provider_id) VALUES ('Leakage Away', 'leak-away') RETURNING id`);
  homeTeamId = Number(home[0].id);
  awayTeamId = Number(away[0].id);

  // three matches between the same two teams, oldest first
  const scores: Array<[number, number]> = [
    [3, 0],
    [1, 4],
    [2, 2],
  ];
  let i = 0;
  for (const [hg, ag] of scores) {
    i += 1;
    await query(
      `INSERT INTO fixtures (provider_fixture_id, competition_id, season_id, home_team_id, away_team_id,
                             kickoff_utc, status_short, home_score, away_score)
       VALUES ($1, $2, $3, $4, $5, $6, 'FT', $7, $8)`,
      [`leak-${i}`, competitionId, seasonId, homeTeamId, awayTeamId, new Date(Date.UTC(2090, 0, i)), hg, ag],
    );
  }
});

afterAll(async () => {
  await closePool();
});

describe('point-in-time training dataset', () => {
  it('never includes the match being described (no look-ahead leakage)', async () => {
    const rows = await fetchPointInTimeDataset(pool, { competitionIds: [competitionId], formMatches: 10 });
    expect(rows).toHaveLength(3);

    const byGoals = new Map(rows.map((r) => [`${r.home_goals}-${r.away_goals}`, r]));
    const first = byGoals.get('3-0');
    const second = byGoals.get('1-4');
    const third = byGoals.get('2-2');

    // oldest match: nothing happened before it
    expect(first?.home_prev_matches).toBe(0);
    expect(first?.away_prev_matches).toBe(0);
    expect(first?.home_goals_for_avg).toBeNull();

    // second match sees exactly the first one (home scored 3, conceded 0)
    expect(second?.home_prev_matches).toBe(1);
    expect(second?.home_goals_for_avg).toBe(3);
    expect(second?.home_goals_against_avg).toBe(0);
    expect(second?.away_goals_for_avg).toBe(0);
    expect(second?.away_goals_against_avg).toBe(3);

    // third match sees both previous ones, not itself
    expect(third?.home_prev_matches).toBe(2);
    expect(third?.home_goals_for_avg).toBe(2); // (3 + 1) / 2
    expect(third?.home_goals_against_avg).toBe(2); // (0 + 4) / 2
    expect(third?.result).toBe('D');
    expect(third?.btts).toBe(1);
  });
});

describe('read-only guard', () => {
  it('refuses a connection that can write to the warehouse', async () => {
    await expect(assertReadOnly(pool)).rejects.toThrow(/not read-only|cannot SELECT/i);
  });
});

describe('poisson fitter', () => {
  const sim = simulate();

  it('recovers team strengths from data that contains signal', () => {
    const train = sim.matches.slice(0, Math.floor(sim.matches.length * 0.8));
    const fitted = fitCompetition(train, new Map(), { iterations: 900 });

    const fittedAttack = new Map(fitted.teams.map((t) => [t.id, t.attack]));
    const fittedDefence = new Map(fitted.teams.map((t) => [t.id, t.defence]));
    const ids = [...sim.trueAttack.keys()];

    const attackCorr = pearson(ids.map((id) => sim.trueAttack.get(id) ?? 0), ids.map((id) => fittedAttack.get(id) ?? 0));
    const defenceCorr = pearson(ids.map((id) => sim.trueDefence.get(id) ?? 0), ids.map((id) => fittedDefence.get(id) ?? 0));

    expect(attackCorr).toBeGreaterThan(0.7);
    expect(defenceCorr).toBeGreaterThan(0.7);
    expect(fitted.homeAdvantage).toBeGreaterThan(0); // simulated home advantage is positive
    expect(fitted.homeAdvantage).toBeLessThan(Math.log(2)); // and not absurd
  });

  it('beats a league-average baseline on held-out matches', () => {
    const cut = Math.floor(sim.matches.length * 0.8);
    const train = sim.matches.slice(0, cut);
    const test = sim.matches.slice(cut);
    const fitted = fitCompetition(train, new Map(), { iterations: 900 });

    const attack = new Map(fitted.teams.map((t) => [t.id, t.attack]));
    const defence = new Map(fitted.teams.map((t) => [t.id, t.defence]));
    const metrics = evaluate({
      matches: test,
      params: { intercept: fitted.intercept, homeAdvantage: fitted.homeAdvantage, rho: fitted.rho, attack, defence },
      baseline: {
        lambdaHome: train.reduce((s, m) => s + m.homeGoals, 0) / train.length,
        lambdaAway: train.reduce((s, m) => s + m.awayGoals, 0) / train.length,
      },
    });

    expect(metrics.oneXTwoLogLoss).toBeLessThan(metrics.baselineLogLoss);
  });

  it('produces a finite rho inside the plausible Dixon–Coles range', () => {
    const fitted = fitCompetition(sim.matches.slice(0, 400), new Map(), { iterations: 300 });
    expect(Number.isFinite(fitted.rho)).toBe(true);
    expect(fitted.rho).toBeGreaterThanOrEqual(-0.35);
    expect(fitted.rho).toBeLessThanOrEqual(0.05);
  });
});
