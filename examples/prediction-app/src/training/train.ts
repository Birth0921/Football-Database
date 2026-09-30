/**
 * `npm run train` — fit the Poisson team-strength model straight from the
 * platform warehouse using the READ-ONLY role.
 *
 *   TRAIN_DATABASE_URL=postgres://football_readonly:…@host:5432/football npm run train
 *
 * What it does
 *  1. refuses to run against a connection that can write (assertReadOnly)
 *  2. loads completed results (optionally one competition: --competition 39)
 *  3. splits chronologically: oldest 80 % train, newest 20 % test
 *  4. fits μ, home advantage, per-team attack/defence by weighted MLE
 *  5. grid-searches the Dixon–Coles ρ on the train split
 *  6. scores the test split and compares against a league-average baseline
 *  7. writes model/poisson-model.json (used automatically at prediction time)
 *  8. optionally exports a leakage-free training CSV (--csv training-data.csv)
 *
 * Nothing is written to the database — ever.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadDotEnv, loadConfig } from '../config.js';
import {
  assertReadOnly,
  fetchCompetitions,
  fetchMatches,
  fetchPointInTimeDataset,
  fetchTeams,
  type TrainingMatch,
} from './dataset.js';
import { evaluate, fitCompetition, type CompetitionFit, type Metrics } from './fit.js';

interface Args {
  csv?: string;
  out?: string;
  competition: number[];
  formMatches: number;
  halfLifeDays: number;
  minMatches: number;
  testFraction: number;
  iterations: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    competition: [],
    formMatches: 10,
    halfLifeDays: 400,
    minMatches: 12,
    testFraction: 0.2,
    iterations: 900,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--csv' && next) args.csv = next;
    else if (flag === '--out' && next) args.out = next;
    else if (flag === '--competition' && next) args.competition.push(Number(next));
    else if (flag === '--form-matches' && next) args.formMatches = Number(next);
    else if (flag === '--half-life' && next) args.halfLifeDays = Number(next);
    else if (flag === '--min-matches' && next) args.minMatches = Number(next);
    else if (flag === '--test-fraction' && next) args.testFraction = Number(next);
    else if (flag === '--iterations' && next) args.iterations = Number(next);
  }
  return args;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
}

function chronologicalSplit(matches: TrainingMatch[], testFraction: number): { train: TrainingMatch[]; test: TrainingMatch[] } {
  const sorted = [...matches].sort((a, b) => a.kickoffUtc.getTime() - b.kickoffUtc.getTime());
  const cut = Math.max(1, Math.floor(sorted.length * (1 - testFraction)));
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));

  if (!config.trainDatabaseUrl) {
    throw new Error(
      'TRAIN_DATABASE_URL is not set.\n' +
        'Create the read-only role (migration 0008) and point TRAIN_DATABASE_URL at it, e.g.\n' +
        '  TRAIN_DATABASE_URL=postgres://football_readonly:SECRET@127.0.0.1:5432/football npm run train',
    );
  }

  const client = new pg.Client({ connectionString: config.trainDatabaseUrl });
  await client.connect();
  try {
    const identity = await assertReadOnly(client);
    console.log(`[train] connected as ${identity.user}@${identity.database} (read-only verified)`);

    const [teamNames, competitionNames] = await Promise.all([fetchTeams(client), fetchCompetitions(client)]);
    const matches = await fetchMatches(client, { competitionIds: args.competition.length ? args.competition : undefined });
    console.log(`[train] loaded ${matches.length} completed matches`);
    if (!matches.length) throw new Error('no completed matches found — import and finalise data first');

    const byCompetition = new Map<number, TrainingMatch[]>();
    for (const m of matches) {
      const list = byCompetition.get(m.competitionId) ?? [];
      list.push(m);
      byCompetition.set(m.competitionId, list);
    }

    const competitions: CompetitionFit[] = [];
    const report: Array<{ competition: string; train: number; test: number; metrics: Metrics }> = [];
    let totalTest = 0;
    let weightedLogLoss = 0;
    let weightedBaseline = 0;
    let weightedAccuracy = 0;

    for (const [competitionId, list] of byCompetition) {
      if (list.length < args.minMatches) {
        console.log(`[train] competition ${competitionId}: skipped (${list.length} matches < ${args.minMatches})`);
        continue;
      }
      const { train, test } = chronologicalSplit(list, args.testFraction);
      const fitted = fitCompetition(train, teamNames, { halfLifeDays: args.halfLifeDays, iterations: args.iterations });

      const attack = new Map(fitted.teams.map((t) => [t.id, t.attack]));
      const defence = new Map(fitted.teams.map((t) => [t.id, t.defence]));
      const baseline = {
        lambdaHome: train.reduce((s, m) => s + m.homeGoals, 0) / Math.max(1, train.length),
        lambdaAway: train.reduce((s, m) => s + m.awayGoals, 0) / Math.max(1, train.length),
      };

      const metrics = evaluate({
        matches: test.length ? test : train,
        params: { intercept: fitted.intercept, homeAdvantage: fitted.homeAdvantage, rho: fitted.rho, attack, defence },
        baseline,
      });

      competitions.push({
        competitionId,
        competitionName: competitionNames.get(competitionId) ?? `Competition ${competitionId}`,
        intercept: fitted.intercept,
        homeAdvantage: fitted.homeAdvantage,
        rho: fitted.rho,
        teams: fitted.teams,
        matchesUsed: train.length,
        trainedAt: new Date().toISOString(),
      });

      report.push({ competition: competitionNames.get(competitionId) ?? String(competitionId), train: train.length, test: test.length, metrics });
      totalTest += metrics.matches;
      weightedLogLoss += metrics.oneXTwoLogLoss * metrics.matches;
      weightedBaseline += metrics.baselineLogLoss * metrics.matches;
      weightedAccuracy += metrics.oneXTwoAccuracy * metrics.matches;
    }

    if (args.csv) {
      const rows = await fetchPointInTimeDataset(client, {
        formMatches: args.formMatches,
        competitionIds: args.competition.length ? args.competition : undefined,
      });
      const csvPath = path.resolve(process.cwd(), args.csv);
      fs.writeFileSync(csvPath, `${toCsv(rows as unknown as Array<Record<string, unknown>>)}\n`);
      console.log(`[train] exported ${rows.length} leakage-free training rows → ${csvPath}`);
    }

    const outPath = path.resolve(process.cwd(), args.out ?? config.modelPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const modelFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      window: { seasons: [], formMatches: args.formMatches, halfLifeDays: args.halfLifeDays },
      evaluation: {
        matches: totalTest,
        oneXTwoLogLoss: round(weightedLogLoss / Math.max(1, totalTest), 4),
        oneXTwoAccuracy: round(weightedAccuracy / Math.max(1, totalTest), 4),
        over25LogLoss: null,
        meanAbsoluteGoalError: null,
        baselineLogLoss: round(weightedBaseline / Math.max(1, totalTest), 4),
      },
      competitions: Object.fromEntries(competitions.map((c) => [String(c.competitionId), c])),
    };
    fs.writeFileSync(outPath, `${JSON.stringify(modelFile, null, 2)}\n`);

    console.log('\n[train] hold-out results (newest 20% of each competition)\n');
    console.table(
      report.map((r) => ({
        competition: r.competition,
        train: r.train,
        test: r.test,
        '1X2 log-loss': r.metrics.oneXTwoLogLoss,
        'baseline log-loss': r.metrics.baselineLogLoss,
        accuracy: r.metrics.oneXTwoAccuracy,
        'O2.5 Brier': r.metrics.over25Brier,
        'goal MAE': r.metrics.meanAbsoluteGoalError,
      })),
    );
    const overall = round(weightedLogLoss / Math.max(1, totalTest), 4);
    const base = round(weightedBaseline / Math.max(1, totalTest), 4);
    console.log(
      `[train] overall 1X2 log-loss ${overall} vs league-average baseline ${base} ` +
        `(${overall < base ? `+${round(base - overall, 4)} better` : `${round(overall - base, 4)} worse`})`,
    );
    console.log(`[train] model written → ${outPath}`);
  } finally {
    await client.end();
  }
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

main().catch((err: Error) => {
  console.error(`[train] failed: ${err.message}`);
  process.exit(1);
});
