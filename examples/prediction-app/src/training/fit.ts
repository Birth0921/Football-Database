/**
 * Maximum-likelihood fit of a time-weighted Poisson team-strength model
 * (Maher / Dixon–Coles style), one parameter set per competition:
 *
 *   λ_home = exp(μ + h + attack(home) + defence(away))
 *   λ_away = exp(μ        + attack(away) + defence(home))
 *
 * - μ  league baseline, h home advantage (log space)
 * - attack/defence are centered every step (identifiability)
 * - recent matches count more (exponential time decay, `halfLifeDays`)
 * - ridge penalty keeps low-sample teams from running away
 * - ρ (Dixon–Coles low-score correction) is grid-searched on the train split
 */
import { poissonPmf, dcTau } from '../predict/poisson.js';
import type { TrainingMatch } from './dataset.js';

export interface FitOptions {
  /** Half-life of a match's weight in days (default 400). */
  halfLifeDays?: number;
  /** L2 penalty on attack/defence parameters (default 0.6). */
  ridge?: number;
  /** Gradient-ascent iterations (default 900). */
  iterations?: number;
  /** Adam learning rate (default 0.05). */
  learningRate?: number;
}

export interface FittedTeam {
  id: number;
  name: string;
  attack: number;
  defence: number;
  matches: number;
}

export interface CompetitionFit {
  competitionId: number;
  competitionName: string;
  /** log-space baseline (μ). */
  intercept: number;
  /** log-space home advantage (h). */
  homeAdvantage: number;
  rho: number;
  teams: FittedTeam[];
  matchesUsed: number;
  trainedAt: string;
}

export interface Metrics {
  matches: number;
  oneXTwoLogLoss: number;
  oneXTwoAccuracy: number;
  over25LogLoss: number;
  over25Brier: number;
  meanAbsoluteGoalError: number;
  /** Log loss of a league-average-only model (no team information). */
  baselineLogLoss: number;
}

const MAX_GOALS = 10;
const ETA_CLAMP = 8;

function clampEta(value: number): number {
  return Math.min(ETA_CLAMP, Math.max(-ETA_CLAMP, value));
}

function decayWeights(matches: TrainingMatch[], halfLifeDays: number): number[] {
  const last = matches.reduce((max, m) => Math.max(max, m.kickoffUtc.getTime()), 0);
  return matches.map((m) => {
    const ageDays = Math.max(0, (last - m.kickoffUtc.getTime()) / 86_400_000);
    return 0.5 ** (ageDays / halfLifeDays);
  });
}

/** Probability of the three outcomes under the (optionally DC-corrected) model. */
export function outcomeProbabilities(lambdaHome: number, lambdaAway: number, rho = 0): { home: number; draw: number; away: number } {
  let home = 0;
  let draw = 0;
  let away = 0;
  let total = 0;
  for (let h = 0; h < MAX_GOALS; h += 1) {
    for (let a = 0; a < MAX_GOALS; a += 1) {
      const p =
        poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) * dcTau(h, a, lambdaHome, lambdaAway, rho);
      total += p;
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  if (total > 0) {
    home /= total;
    draw /= total;
    away /= total;
  }
  return { home, draw, away };
}

export function overUnderProbability(lambdaHome: number, lambdaAway: number, rho = 0, line = 2.5): number {
  let over = 0;
  let total = 0;
  for (let h = 0; h < MAX_GOALS; h += 1) {
    for (let a = 0; a < MAX_GOALS; a += 1) {
      const p =
        poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) * dcTau(h, a, lambdaHome, lambdaAway, rho);
      total += p;
      if (h + a > line) over += p;
    }
  }
  return total > 0 ? over / total : 0;
}

interface Params {
  mu: number;
  h: number;
  attack: Map<number, number>;
  defence: Map<number, number>;
}

function lambdas(params: Params, match: TrainingMatch): { lambdaHome: number; lambdaAway: number } {
  const attH = params.attack.get(match.homeTeamId) ?? 0;
  const attA = params.attack.get(match.awayTeamId) ?? 0;
  const defH = params.defence.get(match.homeTeamId) ?? 0;
  const defA = params.defence.get(match.awayTeamId) ?? 0;
  return {
    lambdaHome: Math.exp(clampEta(params.mu + params.h + attH + defA)),
    lambdaAway: Math.exp(clampEta(params.mu + attA + defH)),
  };
}

/** Full-batch gradient ascent (Adam) with centering and ridge. */
export function fitCompetition(
  matches: TrainingMatch[],
  teamNames: Map<number, string>,
  options: FitOptions = {},
): Omit<CompetitionFit, 'rho' | 'trainedAt'> & { rho: number } {
  const halfLifeDays = options.halfLifeDays ?? 400;
  const ridge = options.ridge ?? 0.6;
  const iterations = options.iterations ?? 900;
  const lr = options.learningRate ?? 0.05;

  const weights = decayWeights(matches, halfLifeDays);
  const meanHomeGoals = weightedMean(matches, weights, (m) => m.homeGoals);
  const meanAwayGoals = weightedMean(matches, weights, (m) => m.awayGoals);

  const params: Params = {
    mu: Math.log(Math.max(0.2, meanAwayGoals)),
    h: Math.log(Math.max(0.5, meanHomeGoals / Math.max(0.2, meanAwayGoals))),
    attack: new Map(),
    defence: new Map(),
  };
  const matchCount = new Map<number, number>();
  for (const m of matches) {
    for (const id of [m.homeTeamId, m.awayTeamId]) {
      params.attack.set(id, 0);
      params.defence.set(id, 0);
      matchCount.set(id, (matchCount.get(id) ?? 0) + 1);
    }
  }

  // Adam state
  const mState = new Map<string, number>();
  const vState = new Map<string, number>();
  const adamStep = (key: string, grad: number, value: { get(): number; set(v: number): void }, iteration: number): void => {
    const m = (mState.get(key) ?? 0) * 0.9 + grad * 0.1;
    const v = (vState.get(key) ?? 0) * 0.999 + grad * grad * 0.001;
    mState.set(key, m);
    vState.set(key, v);
    const mHat = m / (1 - 0.9 ** (iteration + 1));
    const vHat = v / (1 - 0.999 ** (iteration + 1));
    value.set(value.get() + (lr * mHat) / (Math.sqrt(vHat) + 1e-8));
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradAttack = new Map<number, number>();
    const gradDefence = new Map<number, number>();
    let gradMu = 0;
    let gradH = 0;

    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i];
      const w = weights[i];
      const { lambdaHome, lambdaAway } = lambdas(params, match);
      const rHome = match.homeGoals - lambdaHome;
      const rAway = match.awayGoals - lambdaAway;
      gradMu += w * (rHome + rAway);
      gradH += w * rHome;
      gradAttack.set(match.homeTeamId, (gradAttack.get(match.homeTeamId) ?? 0) + w * rHome);
      gradAttack.set(match.awayTeamId, (gradAttack.get(match.awayTeamId) ?? 0) + w * rAway);
      gradDefence.set(match.awayTeamId, (gradDefence.get(match.awayTeamId) ?? 0) + w * rHome);
      gradDefence.set(match.homeTeamId, (gradDefence.get(match.homeTeamId) ?? 0) + w * rAway);
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    adamStep('mu', gradMu / totalWeight, { get: () => params.mu, set: (v) => { params.mu = v; } }, iteration);
    adamStep('h', gradH / totalWeight, { get: () => params.h, set: (v) => { params.h = v; } }, iteration);

    for (const [id, value] of params.attack) {
      const grad = (gradAttack.get(id) ?? 0) / totalWeight - ridge * value;
      adamStep(`a${id}`, grad, { get: () => params.attack.get(id) ?? 0, set: (v) => params.attack.set(id, v) }, iteration);
    }
    for (const [id, value] of params.defence) {
      const grad = (gradDefence.get(id) ?? 0) / totalWeight - ridge * value;
      adamStep(`d${id}`, grad, { get: () => params.defence.get(id) ?? 0, set: (v) => params.defence.set(id, v) }, iteration);
    }

    // Identifiability: keep attack and defence centered at zero.
    const attMean = mean([...params.attack.values()]);
    const defMean = mean([...params.defence.values()]);
    params.mu += attMean + defMean;
    for (const [id, value] of params.attack) params.attack.set(id, value - attMean);
    for (const [id, value] of params.defence) params.defence.set(id, value - defMean);
  }

  const rho = searchRho(matches, weights, params);

  return {
    competitionId: matches[0]?.competitionId ?? 0,
    competitionName: '',
    intercept: round(params.mu),
    homeAdvantage: round(params.h),
    rho: round(rho, 4),
    teams: [...params.attack.keys()].map((id) => ({
      id,
      name: teamNames.get(id) ?? `Team ${id}`,
      attack: round(params.attack.get(id) ?? 0),
      defence: round(params.defence.get(id) ?? 0),
      matches: matchCount.get(id) ?? 0,
    })),
    matchesUsed: matches.length,
  } as Omit<CompetitionFit, 'rho' | 'trainedAt'> & { rho: number };
}

/** Grid-search the Dixon–Coles rho that maximises weighted log-likelihood. */
function searchRho(matches: TrainingMatch[], weights: number[], params: Params): number {
  const candidateLambdas = matches.map((m) => lambdas(params, m));
  let best = 0;
  let bestScore = -Infinity;
  for (let rho = -0.35; rho <= 0.05001; rho += 0.025) {
    let score = 0;
    for (let i = 0; i < matches.length; i += 1) {
      const { lambdaHome, lambdaAway } = candidateLambdas[i];
      const m = matches[i];
      let numerator = 0;
      let total = 0;
      for (let h = 0; h < MAX_GOALS; h += 1) {
        for (let a = 0; a < MAX_GOALS; a += 1) {
          const p =
            poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) * dcTau(h, a, lambdaHome, lambdaAway, rho);
          total += p;
          if (h === m.homeGoals && a === m.awayGoals) numerator = p;
        }
      }
      if (numerator > 0 && total > 0) score += weights[i] * Math.log(numerator / total);
    }
    if (score > bestScore) {
      bestScore = score;
      best = rho;
    }
  }
  return best;
}

export interface EvaluateInput {
  matches: TrainingMatch[];
  params: Pick<CompetitionFit, 'intercept' | 'homeAdvantage' | 'rho'> & {
    attack: Map<number, number>;
    defence: Map<number, number>;
  };
  /** League-average λ used by the no-information baseline model. */
  baseline: { lambdaHome: number; lambdaAway: number };
}

export function evaluate({ matches, params, baseline }: EvaluateInput): Metrics {
  let logLoss = 0;
  let correct = 0;
  let overLogLoss = 0;
  let overBrier = 0;
  let goalError = 0;
  let baselineLogLoss = 0;

  for (const m of matches) {
    const attH = params.attack.get(m.homeTeamId) ?? 0;
    const attA = params.attack.get(m.awayTeamId) ?? 0;
    const defH = params.defence.get(m.homeTeamId) ?? 0;
    const defA = params.defence.get(m.awayTeamId) ?? 0;
    const lambdaHome = Math.exp(clampEta(params.intercept + params.homeAdvantage + attH + defA));
    const lambdaAway = Math.exp(clampEta(params.intercept + attA + defH));
    const probs = outcomeProbabilities(lambdaHome, lambdaAway, params.rho);

    const actual = m.homeGoals > m.awayGoals ? probs.home : m.homeGoals < m.awayGoals ? probs.away : probs.draw;
    logLoss += -Math.log(Math.max(1e-9, actual));
    const predicted = probs.home >= probs.draw && probs.home >= probs.away ? 'H' : probs.away >= probs.draw ? 'A' : 'D';
    const observed = m.homeGoals > m.awayGoals ? 'H' : m.homeGoals < m.awayGoals ? 'A' : 'D';
    if (predicted === observed) correct += 1;

    const pOver = overUnderProbability(lambdaHome, lambdaAway, params.rho, 2.5);
    const yOver = m.homeGoals + m.awayGoals > 2.5 ? 1 : 0;
    overLogLoss += -Math.log(Math.max(1e-9, yOver ? pOver : 1 - pOver));
    overBrier += (pOver - yOver) ** 2;
    goalError += Math.abs(lambdaHome + lambdaAway - (m.homeGoals + m.awayGoals));

    const baseProbs = outcomeProbabilities(baseline.lambdaHome, baseline.lambdaAway, 0);
    const baseActual = m.homeGoals > m.awayGoals ? baseProbs.home : m.homeGoals < m.awayGoals ? baseProbs.away : baseProbs.draw;
    baselineLogLoss += -Math.log(Math.max(1e-9, baseActual));
  }

  const n = matches.length || 1;
  return {
    matches: matches.length,
    oneXTwoLogLoss: round(logLoss / n, 4),
    oneXTwoAccuracy: round(correct / n, 4),
    over25LogLoss: round(overLogLoss / n, 4),
    over25Brier: round(overBrier / n, 4),
    meanAbsoluteGoalError: round(goalError / n, 4),
    baselineLogLoss: round(baselineLogLoss / n, 4),
  };
}

function weightedMean(matches: TrainingMatch[], weights: number[], pick: (m: TrainingMatch) => number): number {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < matches.length; i += 1) {
    sum += weights[i] * pick(matches[i]);
    w += weights[i];
  }
  return w > 0 ? sum / w : 0;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
