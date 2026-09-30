/**
 * Score-model maths: bivariate Poisson with the Dixon–Coles low-score
 * correction. No dependencies, deterministic, fast enough to score thousands
 * of fixtures per second.
 *
 * The platform hands us model-ready features (expected-goal style rates); this
 * module turns two goal expectations (λ_home, λ_away) into every market a
 * prediction app usually shows: 1X2, totals, BTTS, scorelines, fair odds.
 */

export interface ScoreMatrix {
  /** Goals axis length (matrix covers 0…maxGoals-1 for both sides). */
  maxGoals: number;
  /** matrix[home][away] = probability. */
  matrix: number[][];
}

const FACTORIAL: number[] = (() => {
  const f = [1];
  for (let i = 1; i < 30; i += 1) f[i] = f[i - 1] * i;
  return f;
})();

/** Poisson probability mass P(X = k | λ). */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k < 0) return 0;
  return (Math.exp(-lambda) * lambda ** k) / FACTORIAL[k];
}

/**
 * Dixon–Coles τ correction for low-scoring cells.
 * ρ (rho) is negative in practice: the independent-Poisson model underestimates
 * 0–0 and 1–1 and overestimates 1–0 / 0–1.
 */
export function dcTau(homeGoals: number, awayGoals: number, lambdaHome: number, lambdaAway: number, rho: number): number {
  if (rho === 0) return 1;
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

/** Joint score distribution, Dixon–Coles corrected and normalised. */
export function scoreMatrix(lambdaHome: number, lambdaAway: number, maxGoals = 10, rho = 0): ScoreMatrix {
  const matrix: number[][] = [];
  let total = 0;
  for (let h = 0; h < maxGoals; h += 1) {
    const row: number[] = [];
    for (let a = 0; a < maxGoals; a += 1) {
      const p =
        poissonPmf(h, lambdaHome) *
        poissonPmf(a, lambdaAway) *
        dcTau(h, a, lambdaHome, lambdaAway, rho);
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }
  if (total > 0) for (const row of matrix) for (let a = 0; a < row.length; a += 1) row[a] /= total;
  return { maxGoals, matrix };
}

export interface Scoreline {
  home: number;
  away: number;
  probability: number;
}

export interface Markets {
  home: number;
  draw: number;
  away: number;
  over15: number;
  over25: number;
  over35: number;
  under25: number;
  btts: number;
  bttsNo: number;
  doubleChanceHomeOrDraw: number;
  doubleChanceAwayOrDraw: number;
  expectedGoalsHome: number;
  expectedGoalsAway: number;
  expectedTotalGoals: number;
  topScorelines: Scoreline[];
  mostLikelyScoreline: Scoreline;
  /** Fair (vig-free) decimal odds derived from the model probabilities. */
  fairOdds: { home: number; draw: number; away: number };
}

function sumWhere(grid: ScoreMatrix, predicate: (h: number, a: number) => boolean): number {
  let total = 0;
  for (let h = 0; h < grid.maxGoals; h += 1) {
    for (let a = 0; a < grid.maxGoals; a += 1) {
      if (predicate(h, a)) total += grid.matrix[h][a];
    }
  }
  return total;
}

export function markets(grid: ScoreMatrix, lambdaHome: number, lambdaAway: number): Markets {
  const home = sumWhere(grid, (h, a) => h > a);
  const draw = sumWhere(grid, (h, a) => h === a);
  const away = sumWhere(grid, (h, a) => h < a);

  const scorelines: Scoreline[] = [];
  for (let h = 0; h < grid.maxGoals; h += 1) {
    for (let a = 0; a < grid.maxGoals; a += 1) scorelines.push({ home: h, away: a, probability: grid.matrix[h][a] });
  }
  scorelines.sort((x, y) => y.probability - x.probability);

  const over15 = sumWhere(grid, (h, a) => h + a > 1.5);
  const over25 = sumWhere(grid, (h, a) => h + a > 2.5);
  const over35 = sumWhere(grid, (h, a) => h + a > 3.5);
  const btts = sumWhere(grid, (h, a) => h > 0 && a > 0);

  return {
    home,
    draw,
    away,
    over15,
    over25,
    over35,
    under25: 1 - over25,
    btts,
    bttsNo: 1 - btts,
    doubleChanceHomeOrDraw: home + draw,
    doubleChanceAwayOrDraw: away + draw,
    expectedGoalsHome: lambdaHome,
    expectedGoalsAway: lambdaAway,
    expectedTotalGoals: lambdaHome + lambdaAway,
    topScorelines: scorelines.slice(0, 6),
    mostLikelyScoreline: scorelines[0],
    fairOdds: { home: home > 0 ? 1 / home : Infinity, draw: draw > 0 ? 1 / draw : Infinity, away: away > 0 ? 1 / away : Infinity },
  };
}

/** Convenience helper: λ → full market set in one call. */
export function predictFromLambdas(
  lambdaHome: number,
  lambdaAway: number,
  options: { maxGoals?: number; rho?: number } = {},
): { grid: ScoreMatrix; markets: Markets } {
  const grid = scoreMatrix(lambdaHome, lambdaAway, options.maxGoals ?? 10, options.rho ?? 0);
  return { grid, markets: markets(grid, lambdaHome, lambdaAway) };
}

/** Round to `digits` for display without turning 0.004 into 0. */
export function pct(value: number, digits = 1): number {
  const scaled = value * 100;
  return Math.round(scaled * 10 ** digits) / 10 ** digits;
}
