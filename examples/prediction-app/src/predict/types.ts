import type { Markets, ScoreMatrix } from './poisson.js';

/** A competition-season baseline: what an average match looks like there. */
export interface LeagueBaseline {
  competitionId: number;
  seasonId: number;
  goalsPerMatch: number;
  homeGoalsPerMatch: number;
  awayGoalsPerMatch: number;
  completedMatches: number | null;
  /** `api` = from GET /competitions/:id/statistics, `fallback` = derived/default. */
  source: 'api' | 'fallback';
}

export interface StrengthEstimate {
  /** >1 scores more than the league average, <1 fewer. */
  attack: number;
  /** >1 concedes more than the league average, <1 fewer. */
  defence: number;
  /** Matches the rate is based on, after shrinkage weighting. */
  matches: number;
  /** Shrinkage weight in [0,1] — how much we trust the raw rate. */
  shrinkage: number;
  /** Whether expected-goals data was blended in. */
  usedExpectedGoals: boolean;
}

export interface LambdaEstimate {
  lambdaHome: number;
  lambdaAway: number;
  home: StrengthEstimate;
  away: StrengthEstimate;
  baseline: LeagueBaseline;
  notes: string[];
}

export interface PredictionInputs {
  homeForm: string[];
  awayForm: string[];
  homeGoalsAvg: number | null;
  awayGoalsAvg: number | null;
  homeConcededAvg: number | null;
  awayConcededAvg: number | null;
  leagueAvgGoals: number | null;
  h2h: { meetings: number | null; homeWins: number | null; awayWins: number | null; draws: number | null } | null;
  unavailablePlayers: number;
  lineupsKnown: boolean;
  referee: { id: number | null; cardsPerMatch: number | null } | null;
}

export interface TeamStrengthView {
  /** >1 = scores more than the league average. */
  attack: number;
  /** >1 = concedes more than the league average. */
  defence: number;
  /** Matches behind the estimate. */
  matches: number;
  /** Shrinkage weight in [0,1]. */
  shrinkage: number;
}

export interface PredictionModelInfo {
  /** Which lambda source produced the numbers. */
  source: 'trained' | 'features' | 'blended';
  rho: number;
  maxGoals: number;
  blendWeightTrained: number;
  baseline: LeagueBaseline;
  notes: string[];
}

export interface FixturePrediction {
  fixtureId: number;
  kickoffUtc: string | null;
  competitionName: string | null;
  seasonName: string | null;
  round: string | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeTeamName: string;
  awayTeamName: string;
  lambdaHome: number;
  lambdaAway: number;
  markets: Markets;
  grid: ScoreMatrix;
  /** Attack/defence ratios (1.0 = league average) the λ's are built from. */
  strengths: { home: TeamStrengthView; away: TeamStrengthView };
  model: PredictionModelInfo;
  inputs: PredictionInputs;
  freshness: { featuresGeneratedAt: string | null; fixtureLastSyncedAt: string | null; cached: boolean };
}
