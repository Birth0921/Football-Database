/** Standings, injuries/sidelined, transfers, odds pipelines (coverage-aware). */
import { getProvider } from '../../provider/client.js';
import { query, queryOne } from '../../lib/db.js';
import { n, replaceStandings, s, upsertSidelined, upsertTransfer, upsertPlayer, upsertTeam, upsertReferee } from '../../provider/mapper.js';
import type { AfInjury, AfStandingsEntry, AfTransfer, AfOddsEntry } from '../../provider/types.js';
import { getCoverage } from './metadata.js';
import { resolveScopedPair } from '../scope-guard.js';
import { logger } from '../../lib/logger.js';
import { cacheDelPattern } from '../../lib/cache.js';

export async function syncStandings(competitionId: number, seasonId: number): Promise<{ rows: number }> {
  const coverage = await getCoverage(competitionId, seasonId);
  if (coverage?.standings === false) return { rows: 0 };
  const provider = await getProvider();
  const ids = await resolveScopedPair(competitionId, seasonId);
  const res = await provider.get<AfStandingsEntry>('/standings', { league: ids.provider_id, season: ids.season_year });
  const rows = await replaceStandings(ids.competition_season_id, res.data.response as AfStandingsEntry[]);
  await cacheDelPattern('fdp:standings:*');
  return { rows };
}

export async function syncInjuries(competitionId: number, seasonId: number): Promise<{ records: number }> {
  const coverage = await getCoverage(competitionId, seasonId);
  if (coverage?.injuries === false) return { records: 0 };
  const provider = await getProvider();
  const ids = await resolveScopedPair(competitionId, seasonId);
  const res = await provider.get<AfInjury>('/injuries', { league: ids.provider_id, season: ids.season_year });
  const records = res.data.response;

  // Resolve provider IDs in bulk. Injury feeds can contain thousands of rows;
  // doing player/team lookups per row creates thousands of DB round trips.
  const playerProviderIds = [...new Set(
    records.flatMap((rec) => rec.player?.id != null ? [String(rec.player.id)] : []),
  )];
  const teamProviderIds = [...new Set(
    records.flatMap((rec) => rec.team?.id != null ? [String(rec.team.id)] : []),
  )];

  const players = playerProviderIds.length > 0
    ? await query<{ id: number; provider_id: string }>(
        `SELECT id, provider_id FROM players
          WHERE provider = 'api-football' AND provider_id = ANY($1::text[])`,
        [playerProviderIds],
      )
    : [];
  const teams = teamProviderIds.length > 0
    ? await query<{ id: number; provider_id: string }>(
        `SELECT id, provider_id FROM teams
          WHERE provider = 'api-football' AND provider_id = ANY($1::text[])`,
        [teamProviderIds],
      )
    : [];

  const playerIds = new Map(players.map((row) => [String(row.provider_id), Number(row.id)]));
  const teamIds = new Map(teams.map((row) => [String(row.provider_id), Number(row.id)]));

  let count = 0;
  for (const rec of records) {
    const playerId = rec.player?.id != null
      ? playerIds.get(String(rec.player.id)) ?? null
      : null;
    const teamId = rec.team?.id != null
      ? teamIds.get(String(rec.team.id)) ?? null
      : null;
    const ok = await upsertSidelined(rec, {
      playerId,
      teamId,
      competitionId,
      seasonId,
    });
    if (ok) count += 1;
  }
  logger.info({ competitionId, seasonId, count }, 'injuries imported');
  return { records: count };
}

export async function syncTransfers(teamProviderId?: string): Promise<{ records: number }> {
  const provider = await getProvider();
  const params: Record<string, unknown> = teamProviderId ? { team: teamProviderId } : {};
  const res = await provider.get<AfTransfer>('/transfers', params);
  let count = 0;
  for (const rec of res.data.response) {
    let playerId = rec.player?.id != null
      ? (await queryOne<{ id: number }>(`SELECT id FROM players WHERE provider_id = $1`, [String(rec.player.id)]))?.id ?? null
      : null;
    if (!playerId && rec.player?.id != null) {
      playerId = await upsertPlayer({ id: rec.player.id, name: rec.player.name ?? null }, null);
    }
    let fromId: number | null = null;
    if (rec.teams?.out?.id != null) {
      fromId = (await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(rec.teams.out.id)]))?.id ?? null;
      if (fromId == null) {
        fromId = await upsertTeam({ id: rec.teams.out.id, name: rec.teams.out.name, logo: rec.teams.out.logo ?? null, raw: rec.teams.out });
      }
    }
    let toId: number | null = null;
    if (rec.teams?.in?.id != null) {
      toId = (await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(rec.teams.in.id)]))?.id ?? null;
      if (toId == null) {
        toId = await upsertTeam({ id: rec.teams.in.id, name: rec.teams.in.name, logo: rec.teams.in.logo ?? null, raw: rec.teams.in });
      }
    }
    const ok = await upsertTransfer(rec, { playerId, fromTeamId: fromId, toTeamId: toId });
    if (ok) count += 1;
  }
  logger.info({ count }, 'transfers imported');
  return { records: count };
}

export async function syncOdds(competitionId: number, seasonId: number): Promise<{ records: number }> {
  const coverage = await getCoverage(competitionId, seasonId);
  if (coverage?.odds === false) return { records: 0 };
  const provider = await getProvider();
  const ids = await resolveScopedPair(competitionId, seasonId);
  const res = await provider.get<AfOddsEntry>('/odds', { league: ids.provider_id, season: ids.season_year });
  let count = 0;
  for (const entry of res.data.response) {
    const fixtureId = entry.fixture?.id != null
      ? (await queryOne<{ id: number }>(`SELECT id FROM fixtures WHERE provider_fixture_id = $1`, [String(entry.fixture.id)]))?.id
      : undefined;
    if (!fixtureId) continue;
    for (const bm of entry.bookmakers ?? []) {
      const bmRow = await queryOne<{ id: number }>(
        `INSERT INTO bookmakers (name, provider_id, raw) VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now() RETURNING id`,
        [s(bm.name) ?? 'Unknown bookmaker', bm.id != null ? String(bm.id) : null, JSON.stringify(bm)],
      );
      if (!bmRow) continue;
      for (const bet of bm.bets ?? []) {
        const oddsRow = await queryOne<{ id: number }>(
          `INSERT INTO odds (fixture_id, bookmaker_id, market_name, market_id, raw)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (fixture_id, bookmaker_id, market_id, market_name) DO UPDATE SET raw = EXCLUDED.raw, updated_at = now()
           RETURNING id`,
          [fixtureId, bmRow.id, s(bet.name), bet.id != null ? String(bet.id) : null, JSON.stringify(bet)],
        );
        if (!oddsRow) continue;
        for (const v of bet.values ?? []) {
          await query(
            `INSERT INTO odds_values (odds_id, value_name, value_id, odds, raw)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (odds_id, value_id, value_name) DO UPDATE SET odds = EXCLUDED.odds, updated_at = now()`,
            [oddsRow.id, s(v.value), s(v.value), n(v.odd), JSON.stringify(v)],
          );
          count += 1;
        }
      }
    }
  }
  logger.info({ competitionId, seasonId, count }, 'odds imported');
  return { records: count };
}

void upsertReferee;
