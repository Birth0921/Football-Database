/**
 * PredictionService — the glue between the platform API and the model maths.
 *
 * Live path (always available):
 *   GET /fixtures/upcoming  →  GET /predictions/features/:id  →  λ  →  markets
 *
 * Optional trained path (needs `npm run train` against the read-only database):
 *   λ = geometric blend of trained-model λ and feature-model λ.
 *
 * The service never touches the platform database and never sees the
 * API-Football provider key — only a `pf_live_…` key and HTTPS.
 */
import type { FootballDataClient, Fixture, PredictionFeatures } from '@football-data-platform/client';
import { NotFoundError } from '@football-data-platform/client';
import { LeagueBaselineCache } from './baseline.js';
import { lambdasFromFeatures, type FeatureModelOptions } from './feature-model.js';
import { predictFromLambdas } from './poisson.js';
import { TrainedModel } from './trained-model.js';
import type { FixturePrediction, LambdaEstimate, PredictionInputs } from './types.js';

export interface PredictionServiceOptions extends FeatureModelOptions {
  /** Dixon–Coles rho; the trained model overrides it per competition. */
  rho?: number;
  /** Score matrix size (default 10 → 0…9 goals). */
  maxGoals?: number;
  /** Blend weight for the trained model, 0…1 (default 0.5). */
  trainedWeight?: number;
  /** Optional pre-loaded trained model. */
  trainedModel?: TrainedModel | null;
}

export interface UpcomingOptions {
  limit?: number;
  competitionId?: number;
  seasonId?: number;
  /** Parallel feature requests (default 4). */
  concurrency?: number;
}

export interface PredictionBatch {
  predictions: FixturePrediction[];
  skipped: Array<{ fixtureId: number; reason: string }>;
  meta: {
    requestedAt: string;
    fixturesScanned: number;
    modelSource: 'trained' | 'features' | 'blended' | 'mixed';
    rateLimit: { remainingMinute: number | null; remainingDay: number | null };
  };
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, fallback: string | null = ''): string | null {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export class PredictionService {
  private readonly client: FootballDataClient;
  private readonly baselines: LeagueBaselineCache;
  private readonly trained: TrainedModel | null;
  private readonly options: PredictionServiceOptions;

  constructor(client: FootballDataClient, options: PredictionServiceOptions = {}) {
    this.client = client;
    this.options = options;
    this.baselines = new LeagueBaselineCache(client);
    this.trained = options.trainedModel ?? null;
  }

  get trainedModel(): TrainedModel | null {
    return this.trained;
  }

  /** Predict one fixture from its platform features. */
  async predictFixture(fixtureId: number): Promise<FixturePrediction> {
    const { data: features, cached } = await this.client.predictionFeatures(fixtureId);
    return this.predictFromFeatures(features, { cached: Boolean(cached) });
  }

  /** Predict from features you already fetched (batch/backfill friendly). */
  async predictFromFeatures(features: PredictionFeatures, meta: { cached?: boolean } = {}): Promise<FixturePrediction> {
    const fixture = (features.fixture ?? {}) as Record<string, unknown>;
    const competitionId = num(features.competition_id) ?? 0;
    const seasonId = num(features.season_id) ?? 0;
    const homeTeamId = num(features.home_team_id);
    const awayTeamId = num(features.away_team_id);

    const baseline = await this.baselines.get(competitionId, seasonId, num(features.league_avg_goals));
    const featureLambda = lambdasFromFeatures(features, baseline, this.options);

    let lambdaHome = featureLambda.lambdaHome;
    let lambdaAway = featureLambda.lambdaAway;
    let source: 'trained' | 'features' | 'blended' = 'features';
    let rho = this.options.rho ?? 0;
    const notes = [...featureLambda.notes];

    const trainedLambda =
      homeTeamId !== null && awayTeamId !== null && this.trained
        ? this.trained.lambdas(competitionId, homeTeamId, awayTeamId)
        : null;

    if (trainedLambda) {
      const w = clamp01(this.options.trainedWeight ?? 0.5);
      if (w >= 0.999) {
        lambdaHome = trainedLambda.lambdaHome;
        lambdaAway = trainedLambda.lambdaAway;
        source = 'trained';
        rho = trainedLambda.rho;
        notes.push('λ from the trained Poisson model (read-only database training run)');
      } else if (w <= 0.001) {
        notes.push('trained model available but weight = 0 — using platform features only');
      } else {
        // Geometric blend: log λ is a weighted average, which keeps λ positive
        // and is the natural way to average multiplicative strengths.
        lambdaHome = Math.exp((1 - w) * Math.log(featureLambda.lambdaHome) + w * Math.log(trainedLambda.lambdaHome));
        lambdaAway = Math.exp((1 - w) * Math.log(featureLambda.lambdaAway) + w * Math.log(trainedLambda.lambdaAway));
        source = 'blended';
        rho = (1 - w) * rho + w * trainedLambda.rho;
        notes.push(`λ blended: ${Math.round((1 - w) * 100)}% features / ${Math.round(w * 100)}% trained model`);
      }
    }

    const { grid, markets } = predictFromLambdas(lambdaHome, lambdaAway, {
      maxGoals: this.options.maxGoals ?? 10,
      rho,
    });

    return {
      fixtureId: num(features.fixture_id) ?? num(fixture.id) ?? 0,
      kickoffUtc: str(fixture.kickoff_utc, null),
      competitionName: str(fixture.competition_name, null),
      seasonName: str(fixture.season_name, null),
      round: str(fixture.round, null),
      homeTeamId,
      awayTeamId,
      homeTeamName: str(fixture.home_team_name) ?? `Team ${homeTeamId ?? '?'}`,
      awayTeamName: str(fixture.away_team_name) ?? `Team ${awayTeamId ?? '?'}`,
      lambdaHome: round(lambdaHome),
      lambdaAway: round(lambdaAway),
      markets,
      grid,
      strengths: {
        home: { attack: featureLambda.home.attack, defence: featureLambda.home.defence, matches: featureLambda.home.matches, shrinkage: featureLambda.home.shrinkage },
        away: { attack: featureLambda.away.attack, defence: featureLambda.away.defence, matches: featureLambda.away.matches, shrinkage: featureLambda.away.shrinkage },
      },
      model: {
        source,
        rho: round(rho),
        maxGoals: this.options.maxGoals ?? 10,
        blendWeightTrained: this.options.trainedWeight ?? 0.5,
        baseline,
        notes,
      },
      inputs: summariseInputs(features),
      freshness: {
        featuresGeneratedAt: str(features.data_freshness?.generatedAt, null),
        fixtureLastSyncedAt: str(features.data_freshness?.fixtureLastSyncedAt ?? fixture.last_synced_at, null),
        cached: Boolean(meta.cached),
      },
    };
  }

  /**
   * Score the next fixtures. One call to list, then one per fixture for its
   * features (the platform computes them locally, so this is cheap).
   */
  async predictUpcoming(options: UpcomingOptions = {}): Promise<PredictionBatch> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const concurrency = Math.max(1, options.concurrency ?? 4);

    const page = await this.client.fixturesUpcoming({ per_page: limit });
    let fixtures: Fixture[] = page.data;

    if (options.competitionId) {
      fixtures = fixtures.filter((f) => num(f.competition_id) === options.competitionId);
    }
    if (options.seasonId) {
      fixtures = fixtures.filter((f) => num(f.season_id) === options.seasonId);
    }

    const predictions: FixturePrediction[] = [];
    const skipped: Array<{ fixtureId: number; reason: string }> = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= fixtures.length) return;
        const fixture = fixtures[index];
        const id = num(fixture.id);
        if (id === null) continue;
        try {
          predictions.push(await this.predictFixture(id));
        } catch (err) {
          const reason =
            err instanceof NotFoundError
              ? 'prediction features not built for this fixture yet (run: npm run prediction-features:rebuild)'
              : (err as Error).message;
          skipped.push({ fixtureId: id, reason });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, fixtures.length)) }, worker));

    predictions.sort((a, b) => (a.kickoffUtc ?? '').localeCompare(b.kickoffUtc ?? ''));
    const sources = new Set(predictions.map((p) => p.model.source));

    return {
      predictions,
      skipped,
      meta: {
        requestedAt: new Date().toISOString(),
        fixturesScanned: fixtures.length,
        modelSource: sources.size === 1 ? [...sources][0] : 'mixed',
        rateLimit: { ...this.client.rateLimit },
      },
    };
  }
}

function summariseInputs(features: PredictionFeatures): PredictionInputs {
  const h2h = features.h2h;
  const referee = features.referee_features;
  return {
    homeForm: features.home_form?.form ?? [],
    awayForm: features.away_form?.form ?? [],
    homeGoalsAvg: num(features.home_goals_avg),
    awayGoalsAvg: num(features.away_goals_avg),
    homeConcededAvg: num(features.home_conceded_avg),
    awayConcededAvg: num(features.away_conceded_avg),
    leagueAvgGoals: num(features.league_avg_goals),
    h2h: h2h
      ? {
          meetings: num(h2h.fixturesCount),
          homeWins: num(h2h.aWins),
          awayWins: num(h2h.bWins),
          draws: num(h2h.draws),
        }
      : null,
    unavailablePlayers: Array.isArray(features.player_availability) ? features.player_availability.length : 0,
    lineupsKnown: Array.isArray(features.lineups_available) && features.lineups_available.length > 0,
    referee: {
      id: num(features.referee_id),
      cardsPerMatch: num(referee?.cards_per_match),
    },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export type { FixturePrediction, LambdaEstimate };
