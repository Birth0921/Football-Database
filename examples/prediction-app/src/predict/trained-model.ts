/**
 * Trained Poisson parameters produced by `npm run train`
 * (`src/training/train.ts`, which reads the warehouse through the read-only
 * role with point-in-time features).
 *
 * At prediction time we need nothing but the team ids:
 *   λ_home = exp(intercept + homeAdvantage + attack(home) + defence(away))
 *   λ_away = exp(intercept              + attack(away) + defence(home))
 *
 * The model file is optional — when it is missing (or does not know a team) the
 * service silently falls back to the feature-based model.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TrainedTeam {
  name: string;
  /** log-space attacking strength. */
  attack: number;
  /** log-space defensive weakness (higher = concedes more). */
  defence: number;
  matches: number;
}

export interface TrainedCompetition {
  competitionId: number;
  competitionName?: string;
  intercept: number;
  homeAdvantage: number;
  rho: number;
  teams: Record<string, TrainedTeam>;
  matchesUsed: number;
  trainedAt: string;
}

export interface TrainedModelFile {
  version: number;
  generatedAt: string;
  window: { seasons: number[]; formMatches: number; halfLifeDays: number };
  evaluation: {
    matches: number;
    oneXTwoLogLoss: number | null;
    oneXTwoAccuracy: number | null;
    over25LogLoss: number | null;
    meanAbsoluteGoalError: number | null;
    baselineLogLoss: number | null;
  } | null;
  competitions: Record<string, TrainedCompetition>;
}

export class TrainedModel {
  readonly file: TrainedModelFile;

  private constructor(file: TrainedModelFile) {
    this.file = file;
  }

  /** Load a model file. Returns null when it does not exist (feature-only mode). */
  static load(modelPath: string): TrainedModel | null {
    try {
      if (!fs.existsSync(modelPath)) return null;
      const raw = fs.readFileSync(modelPath, 'utf8');
      const parsed = JSON.parse(raw) as TrainedModelFile;
      if (!parsed || typeof parsed !== 'object' || !parsed.competitions) return null;
      return new TrainedModel(parsed);
    } catch {
      return null;
    }
  }

  static loadFromEnv(env: NodeJS.ProcessEnv = process.env, repoRoot = process.cwd()): TrainedModel | null {
    const configured = env.PREDICTION_MODEL_PATH;
    const resolved = configured
      ? path.resolve(repoRoot, configured)
      : path.resolve(repoRoot, 'model/poisson-model.json');
    return TrainedModel.load(resolved);
  }

  competition(competitionId: number): TrainedCompetition | null {
    return this.file.competitions[String(competitionId)] ?? null;
  }

  team(competitionId: number, teamId: number): TrainedTeam | null {
    const comp = this.competition(competitionId);
    return comp?.teams[String(teamId)] ?? null;
  }

  /** True when both teams are known so the trained model can be used. */
  covers(competitionId: number, homeTeamId: number | null, awayTeamId: number | null): boolean {
    if (homeTeamId === null || awayTeamId === null) return false;
    return Boolean(this.team(competitionId, homeTeamId) && this.team(competitionId, awayTeamId));
  }

  lambdas(competitionId: number, homeTeamId: number, awayTeamId: number): { lambdaHome: number; lambdaAway: number; rho: number } | null {
    const comp = this.competition(competitionId);
    const home = comp?.teams[String(homeTeamId)];
    const away = comp?.teams[String(awayTeamId)];
    if (!comp || !home || !away) return null;
    const lambdaHome = Math.exp(comp.intercept + comp.homeAdvantage + home.attack + away.defence);
    const lambdaAway = Math.exp(comp.intercept + away.attack + home.defence);
    return { lambdaHome: clampLambda(lambdaHome), lambdaAway: clampLambda(lambdaAway), rho: comp.rho ?? 0 };
  }
}

function clampLambda(value: number): number {
  return Math.min(5, Math.max(0.15, value));
}
