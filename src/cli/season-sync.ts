import { runCli, bootstrap, runTaskOnce, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap();
  const seasonId = Number(args.season ?? args._[0]);
  if (!seasonId) throw new Error('usage: npm run season:sync -- --season <id>');
  const rows = await (await import('../lib/db.js')).query(
    `SELECT cs.competition_id
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.season_id = $1 AND cs.import_scope = 'in_scope'
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope'`, [seasonId]);
  for (const r of rows) {
    await runTaskOnce('fixtures:import', { competitionId: r.competition_id, seasonId, force: args.force === true }, `cli:season:${seasonId}:${r.competition_id}:${Date.now()}`);
    await runTaskOnce('standings:sync', { competitionId: r.competition_id, seasonId }, `cli:season-st:${seasonId}:${r.competition_id}:${Date.now()}`);
  }
  return { seasonId, competitions: rows.length };
});
