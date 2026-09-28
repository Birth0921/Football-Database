import { runCli, bootstrap, runTaskOnce, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap();
  const competitionId = Number(args.competition ?? args._[0]);
  if (!competitionId) throw new Error('usage: npm run competition:sync -- --competition <id>');
  const seasons = await (await import('../lib/db.js')).query(
    `SELECT cs.season_id
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.competition_id = $1 AND cs.import_scope = 'in_scope'
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope'
      ORDER BY se.year DESC`, [competitionId]);
  const results = [] as unknown[];
  for (const s of seasons) {
    results.push(await runTaskOnce('fixtures:import', { competitionId, seasonId: s.season_id }, `cli:comp:${competitionId}:${s.season_id}:${Date.now()}`));
    await runTaskOnce('standings:sync', { competitionId, seasonId: s.season_id }, `cli:standings:${competitionId}:${s.season_id}:${Date.now()}`);
  }
  return { competitionId, seasons: seasons.length, results };
});
