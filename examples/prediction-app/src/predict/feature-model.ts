/**
 * Turn platform prediction features into goal expectations (λ_home, λ_away).
 *
 * Model: a standard multiplicative Poisson "attack × defence × baseline" model.
 *
 *   λ_home = attack(home) · defence(away) · leagueHomeGoalsPerMatch
 *   λ_away = attack(away) · defence(home) · leagueAwayGoalsPerMatch
 *
 * Three things keep it honest on small samples:
 *  1. **Shrinkage** — team rates are pulled toward the league average by
 *     n / (n + K), so a team with 3 matches does not get a wild λ.
 *  2. **xG blending** — when the platform has expected goals, goals and xG are
 *     blended (xG is less noisy for the same number of matches).
 *  3. **Venue split** — home/away form is used as a damped multiplier, because
 *     some teams are dramatically better at home than away.
 */
import type { PredictionFeatures } from '@football-data-platform/client';
import type { LeagueBaseline, LambdaEstimate, StrengthEstimate } from './types.js';

export interface FeatureModelOptions {
  /** Shrinkage constant K: larger = more conservative (default 6). */
  shrinkageK?: number;
  /** Weight of expected goals in the attack estimate, 0…1 (default 0.5). */
  xgWeight?: number;
  /** Weight of the venue-split multiplier, 0…1 (default 0.35). */
  venueWeight?: number;
}

const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 5;

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function ppg(form: unknown): number | null {
  const f = form as { pointsPerGame?: number | null; matches?: number } | null | undefined;
  if (!f) return null;
  return num(f.pointsPerGame);
}

/** Shrink a raw rate ratio toward 1.0 based on sample size. */
function shrink(raw: number, matches: number | null, k: number): { value: number; weight: number } {
  const n = Math.max(0, matches ?? 0);
  const weight = n / (n + k);
  return { value: 1 + weight * (raw - 1), weight: Number(weight.toFixed(3)) };
}

function teamStatsMatches(stats: PredictionFeatures['home_team_stats']): number | null {
  return num(stats?.matches) ?? null;
}

function xgPerMatch(stats: PredictionFeatures['home_team_stats']): number | null {
  const xg = num(stats?.expected_goals);
  const matches = num(stats?.matches);
  if (xg === null || !matches || matches <= 0) return null;
  const per = xg / matches;
  return per > 0.1 && per < 5 ? per : null;
}

/**
 * λ estimate from platform features. `baseline` should come from
 * {@link LeagueBaselineCache}; features.league_avg_goals is used as a fallback.
 */
export function lambdasFromFeatures(
  features: PredictionFeatures,
  baseline: LeagueBaseline,
  options: FeatureModelOptions = {},
): LambdaEstimate {
  const k = options.shrinkageK ?? 6;
  const xgWeight = clamp(options.xgWeight ?? 0.5, 0, 1);
  const venueWeight = clamp(options.venueWeight ?? 0.35, 0, 1);
  const notes: string[] = [];

  const teamAvg = baseline.goalsPerMatch / 2;
  const homeMatches = teamStatsMatches(features.home_team_stats);
  const awayMatches = teamStatsMatches(features.away_team_stats);

  // --- raw attack / defence ratios ------------------------------------------
  const homeScored = num(features.home_goals_avg);
  const homeConceded = num(features.home_conceded_avg);
  const awayScored = num(features.away_goals_avg);
  const awayConceded = num(features.away_conceded_avg);

  let homeAttackRaw = homeScored !== null ? homeScored / teamAvg : null;
  let homeDefenceRaw = homeConceded !== null ? homeConceded / teamAvg : null;
  let awayAttackRaw = awayScored !== null ? awayScored / teamAvg : null;
  let awayDefenceRaw = awayConceded !== null ? awayConceded / teamAvg : null;

  // --- xG blend (attack only — xG against is not exposed per team) ----------
  let usedXg = false;
  const homeXg = xgPerMatch(features.home_team_stats);
  const awayXg = xgPerMatch(features.away_team_stats);
  if (homeAttackRaw !== null && homeXg !== null && xgWeight > 0) {
    homeAttackRaw = (1 - xgWeight) * homeAttackRaw + xgWeight * (homeXg / teamAvg);
    usedXg = true;
  }
  if (awayAttackRaw !== null && awayXg !== null && xgWeight > 0) {
    awayAttackRaw = (1 - xgWeight) * awayAttackRaw + xgWeight * (awayXg / teamAvg);
    usedXg = true;
  }
  if (usedXg) notes.push(`attack estimates blend goals with expected goals (w=${xgWeight})`);

  if (homeAttackRaw === null || homeDefenceRaw === null || awayAttackRaw === null || awayDefenceRaw === null) {
    notes.push('one or both teams lack scoring/conceding history — falling back to the league baseline');
  }

  const homeAttack = shrink(homeAttackRaw ?? 1, homeMatches, k);
  const homeDefence = shrink(homeDefenceRaw ?? 1, homeMatches, k);
  const awayAttack = shrink(awayAttackRaw ?? 1, awayMatches, k);
  const awayDefence = shrink(awayDefenceRaw ?? 1, awayMatches, k);

  // --- venue split (damped) -------------------------------------------------
  const homeVenue = venueMultiplier(ppg(features.home_home_form), ppg(features.home_form), venueWeight);
  const awayVenue = venueMultiplier(ppg(features.away_away_form), ppg(features.away_form), venueWeight);
  if (homeVenue !== 1 || awayVenue !== 1) {
    notes.push(`venue split applied: home ×${homeVenue.toFixed(2)}, away ×${awayVenue.toFixed(2)}`);
  }

  const lambdaHome = clamp(homeAttack.value * awayDefence.value * baseline.homeGoalsPerMatch * homeVenue, LAMBDA_MIN, LAMBDA_MAX);
  const lambdaAway = clamp(awayAttack.value * homeDefence.value * baseline.awayGoalsPerMatch * awayVenue, LAMBDA_MIN, LAMBDA_MAX);

  const home: StrengthEstimate = {
    attack: round(homeAttack.value),
    defence: round(homeDefence.value),
    matches: homeMatches ?? 0,
    shrinkage: homeAttack.weight,
    usedExpectedGoals: usedXg && homeXg !== null,
  };
  const away: StrengthEstimate = {
    attack: round(awayAttack.value),
    defence: round(awayDefence.value),
    matches: awayMatches ?? 0,
    shrinkage: awayAttack.weight,
    usedExpectedGoals: usedXg && awayXg !== null,
  };

  if (baseline.source === 'fallback') notes.push('league baseline fell back to defaults (no league statistics yet)');

  return { lambdaHome: round(lambdaHome), lambdaAway: round(lambdaAway), home, away, baseline, notes };
}

function venueMultiplier(venuePpg: number | null, overallPpg: number | null, weight: number): number {
  if (venuePpg === null || overallPpg === null || weight === 0) return 1;
  if (overallPpg <= 0) return 1;
  const ratio = clamp(venuePpg / overallPpg, 0.5, 1.8);
  return 1 + weight * (ratio - 1);
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
