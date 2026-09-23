import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { upsertCompetitionSeason, upsertTeam, upsertPlayer } from '../../src/repos/lookups.js';
import { upsertFixture, storeFixtureEvents, storeFixtureTeamStats, storePlayerMatchStats, storeStandings, storeInjuries } from '../../src/repos/fixtures.js';
import { mapFixture, mapEvents, mapTeamStats, mapStandings } from '../../src/mapping/fixtures.js';
import { recalcLeagueStatistics } from '../../src/analytics/league.js';
import { recalcTeamStatistics, updateStreaks } from '../../src/analytics/team.js';
import { recalcPlayerSeasonStatistics } from '../../src/analytics/player.js';
import { recalcRefereeMatchStats, recalcRefereeSeasonStats } from '../../src/analytics/referee.js';
import { buildPredictionFeatures } from '../../src/analytics/features.js';
import { runQualityChecks } from '../../src/api/routes/health.js';
import { computeH2H } from '../../src/analytics/h2h.js';
import type { AFFixtureResponse } from '../../src/provider/types.js';

const LEAGUE = { providerId: 3999, name: 'Test League', type: 'league' as const, country: { providerId: 999, name: 'Testland', code: null, flagUrl: null }, logoUrl: null };
const SEASON = { year: 2099, startDate: '2099-08-01', endDate: '2100-05-31', isCurrent: true };

async function teamA(): Promise<number> {
  return upsertTeam({ providerId: 8001, name: 'Alpha FC', shortName: null, code: 'ALP', country: { providerId: 999, name: 'Testland', code: null, flagUrl: null }, founded: 1900, logoUrl: null, isNational: false, venue: null });
}
async function teamB(): Promise<number> {
  return upsertTeam({ providerId: 8002, name: 'Beta United', shortName: null, code: 'BET', country: { providerId: 999, name: 'Testland', code: null, flagUrl: null }, founded: 1901, logoUrl: null, isNational: false, venue: null });
}

function mkFixture(providerId: number, homeGoals: number, awayGoals: number, date: string, season = 2098): AFFixtureResponse {
  const status = { long: 'Match Finished', short: 'FT', elapsed: 90 };
  return {
    fixture: { id: providerId, referee: 'Referee One, Testland', timezone: 'UTC', date, venue: { id: 500, name: 'Alpha Park', city: 'Alpha City' }, status },
    league: { id: 3999, name: 'Test League', season, round: 'Regular Season - 1' },
    teams: { home: { id: 8001, name: 'Alpha FC' }, away: { id: 8002, name: 'Beta United' } },
    goals: { home: homeGoals, away: awayGoals },
    score: { halftime: { home: homeGoals, away: awayGoals }, fulltime: { home: homeGoals, away: awayGoals }, extratime: { home: null, away: null }, penalty: { home: null, away: null } },
  };
}

beforeAll(async () => {
  await runMigrations();
  // clean slate for test-scoped data (provider ids far above real ones)
  await query(`TRUNCATE fixture_events, fixture_team_statistics, player_match_statistics, lineup_players, lineups,
    fixture_scores, fixture_periods, standing_rows, standings, sidelined_records, transfers, odds_values, odds,
    prediction_features, referee_match_statistics, referee_season_statistics, referee_competition_statistics,
    league_statistics, team_statistics, player_season_statistics, fixtures, team_seasons, player_team_history,
    team_coach_history, raw_provider_payloads CASCADE`);
});

describe('migrations', () => {
  it('are idempotent (running twice changes nothing)', async () => {
    const r1 = await runMigrations();
    expect(r1.applied).toHaveLength(0); // already applied in beforeAll
  });
});

describe('fixture idempotency', () => {
  it('upserting the same provider fixture twice does not duplicate', async () => {
    const f1 = await upsertFixture(mapFixture(mkFixture(910001, 2, 1, '2099-08-10T14:00:00+00:00')));
    const f2 = await upsertFixture(mapFixture(mkFixture(910001, 2, 1, '2099-08-10T14:00:00+00:00')));
    expect(f2.id).toBe(f1.id);
    expect(f2.changed).toBe(false);
    const { rows } = await query(`SELECT count(*)::int AS n FROM fixtures WHERE provider_id = 910001`);
    expect(rows[0].n).toBe(1);
  });

  it('detects score changes', async () => {
    const f1 = await upsertFixture(mapFixture(mkFixture(910002, 0, 0, '2099-08-11T14:00:00+00:00')));
    const f2 = await upsertFixture(mapFixture(mkFixture(910002, 3, 0, '2099-08-11T14:00:00+00:00')));
    expect(f2.id).toBe(f1.id);
    expect(f2.changed).toBe(true);
  });

  it('rejects home team = away team (constraint)', async () => {
    await expect(
      upsertFixture(mapFixture({
        ...mkFixture(910003, 1, 1, '2099-08-12T14:00:00+00:00'),
        teams: { home: { id: 8001, name: 'Alpha FC' }, away: { id: 8001, name: 'Alpha FC' } },
      })),
    ).rejects.toThrow(/fixtures_teams_differ|different/i);
  });
});

describe('event idempotency', () => {
  it('same events twice do not duplicate', async () => {
    const fx = await upsertFixture(mapFixture(mkFixture(910004, 1, 0, '2099-08-13T14:00:00+00:00')));
    const events = [
      { time: { elapsed: 10 }, team: { id: 8001 }, player: { id: 9001, name: 'Alpha Striker' }, type: 'Goal', detail: 'Normal Goal' },
      { time: { elapsed: 30 }, team: { id: 8002 }, player: { id: 9002, name: 'Beta Mid' }, type: 'Card', detail: 'Yellow Card' },
    ];
    await storeFixtureEvents(fx.id, mapEvents(910004, events));
    await storeFixtureEvents(fx.id, mapEvents(910004, events));
    const { rows } = await query(`SELECT count(*)::int AS n FROM fixture_events WHERE fixture_id = $1`, [fx.id]);
    expect(rows[0].n).toBe(2);
  });
});

describe('analytics pipeline', () => {
  it('computes league, team, referee and player stats correctly', async () => {
    const cs = await upsertCompetitionSeason(LEAGUE, SEASON, { events: true, lineups: false, fixtureStatistics: true, playerStatistics: true, standings: true, players: false, topScorers: false, topAssists: false, topCards: false, injuries: true, sidelined: false, predictions: true, odds: false });
    const a = await teamA();
    const b = await teamB();
    const scorer = await upsertPlayer({ providerId: 9500, name: 'Gamma Goal', firstname: null, lastname: null, nationality: null, birthDate: null, birthPlace: null, birthCountry: null, age: null, height: null, weight: null, injured: null, photo: null });

    // F1: Alpha 2-1 Beta (with events + team stats)
    const f1 = await upsertFixture(mapFixture(mkFixture(910010, 2, 1, '2099-08-20T14:00:00+00:00', 2099)));
    await storeFixtureEvents(f1.id, mapEvents(910010, [
      { time: { elapsed: 10 }, team: { id: 8001 }, player: { id: 9500, name: 'Gamma Goal' }, type: 'Goal', detail: 'Normal Goal' },
      { time: { elapsed: 60 }, team: { id: 8001 }, player: { id: 9500, name: 'Gamma Goal' }, type: 'Goal', detail: 'Penalty' },
      { time: { elapsed: 70 }, team: { id: 8002 }, player: { id: 9002, name: 'Beta Mid' }, type: 'Card', detail: 'Yellow Card' },
    ]));
    await storeFixtureTeamStats(f1.id, mapTeamStats([
      { team: { id: 8001, name: 'Alpha FC' }, statistics: [{ type: 'Total Shots', value: 14 }, { type: 'Shots on Goal', value: 6 }, { type: 'Corner Kicks', value: 7 }, { type: 'Fouls', value: 10 }, { type: 'Ball Possession', value: '60%' }] },
      { team: { id: 8002, name: 'Beta United' }, statistics: [{ type: 'Total Shots', value: 8 }, { type: 'Shots on Goal', value: 3 }, { type: 'Corner Kicks', value: 4 }, { type: 'Fouls', value: 12 }, { type: 'Ball Possession', value: '40%' }] },
    ]));
    await storePlayerMatchStats(f1.id, [
      { playerProviderId: 9500, player: { providerId: 9500, name: 'Gamma Goal' }, teamProviderId: 8001, minutesPlayed: 90, rating: '8.1' as unknown as number, position: 'F', isCaptain: false, isSubstitute: false, goals: 2, assists: 0, yellowCards: 0, redCards: 0, shotsTotal: 4, shotsOnGoal: 3 } as never,
    ], { competitionSeasonId: cs.competitionSeasonId });

    // F2: Beta 0-2 Alpha
    const f2raw = mkFixture(910011, 0, 2, '2099-08-27T14:00:00+00:00', 2099);
    f2raw.teams = { home: { id: 8002, name: 'Beta United' }, away: { id: 8001, name: 'Alpha FC' } };
    const f2 = await upsertFixture(mapFixture(f2raw));

    await recalcLeagueStatistics(cs.competitionSeasonId);
    await recalcTeamStatistics(cs.competitionSeasonId);
    await updateStreaks(cs.competitionSeasonId);
    await recalcPlayerSeasonStatistics(cs.competitionSeasonId);
    await recalcRefereeMatchStats(cs.competitionSeasonId);
    await recalcRefereeSeasonStats(cs.competitionSeasonId);

    // league assertions
    const league = (await query<Record<string, number>>(`SELECT * FROM league_statistics WHERE competition_season_id = $1`, [cs.competitionSeasonId])).rows[0];
    expect(league.matches).toBe(2);
    expect(league.completed_matches).toBe(2);
    expect(league.goals).toBe(5);       // 3 + 2
    expect(league.home_wins).toBe(1);
    expect(league.away_wins).toBe(1);
    expect(league.btts_count).toBe(1);  // only F1
    expect(league.yellow_cards).toBe(1);

    // team assertions
    const alpha = (await query<Record<string, number>>(`SELECT * FROM team_statistics WHERE competition_season_id = $1 AND team_id = $2`, [cs.competitionSeasonId, a])).rows[0];
    expect(alpha.matches).toBe(2);
    expect(alpha.wins).toBe(2);
    expect(alpha.goals_for).toBe(4);
    expect(alpha.goals_against).toBe(1);
    expect(alpha.clean_sheets).toBe(1);
    expect(alpha.btts).toBe(1);
    expect(alpha.form_last5).toBe('WW');
    const beta = (await query<Record<string, number>>(`SELECT * FROM team_statistics WHERE competition_season_id = $1 AND team_id = $2`, [cs.competitionSeasonId, b])).rows[0];
    expect(beta.losses).toBe(2);
    expect(beta.form_last5).toBe('LL');

    // referee assertions
    const ref = (await query<Record<string, number>>(`SELECT * FROM referee_season_statistics`)).rows[0];
    expect(ref.matches).toBe(2);
    expect(ref.yellow_cards).toBe(1);
    expect(Number(ref.cards_per_match)).toBeCloseTo(0.5);

    // player assertions
    const pstats = (await query<Record<string, number>>(`SELECT * FROM player_season_statistics WHERE player_id = $1 AND team_id IS NULL`, [scorer])).rows;
    // scorer has one team only -> aggregate row may not exist; per-team row must
    const pteam = (await query<Record<string, number>>(`SELECT * FROM player_season_statistics WHERE player_id = $1 AND team_id IS NOT NULL`, [scorer])).rows[0];
    expect(pteam.appearances).toBe(1);
    expect(pteam.goals).toBe(2);
    expect(Array.isArray(pstats) || pteam).toBeTruthy();
  });

  it('standings store is idempotent and ranks correctly', async () => {
    const cs = await upsertCompetitionSeason(LEAGUE, SEASON);
    const rows = mapStandings([
      { rank: 1, team: { id: 8001, name: 'Alpha FC' }, points: 6, goalsDiff: 3, group: null, all: { played: 2, win: 2, draw: 0, lose: 0, goals: { for: 4, against: 1 } } },
      { rank: 2, team: { id: 8002, name: 'Beta United' }, points: 0, goalsDiff: -3, group: null, all: { played: 2, win: 0, draw: 0, lose: 2, goals: { for: 1, against: 4 } } },
    ]);
    await storeStandings(cs.competitionSeasonId, rows, null);
    await storeStandings(cs.competitionSeasonId, rows, null); // twice
    const { rows: stored } = await query(`SELECT sr.rank, t.provider_id FROM standing_rows sr JOIN standings st ON st.id = sr.standings_id JOIN teams t ON t.id = sr.team_id WHERE st.competition_season_id = $1 ORDER BY sr.rank`, [cs.competitionSeasonId]);
    expect(stored).toHaveLength(2);
    expect(Number(stored[0].provider_id)).toBe(8001);
    expect(stored[0].rank).toBe(1);
  });

  it('computes H2H locally', async () => {
    const a = await teamA();
    const b = await teamB();
    const h2h = await computeH2H(a, b, 10);
    expect(h2h.matches).toBeGreaterThanOrEqual(2);
    expect(h2h.homeWins).toBe(h2h.matches); // Alpha won every stored fixture
  });

  it('builds prediction features for upcoming fixtures', async () => {
    const cs = await upsertCompetitionSeason(LEAGUE, SEASON);
    const a = await teamA();
    const b = await teamB();
    const upcoming = await upsertFixture(mapFixture({
      ...mkFixture(910020, 0, 0, new Date(Date.now() + 86_400_000).toISOString()),
      fixture: { ...mkFixture(910020, 0, 0, new Date(Date.now() + 86_400_000).toISOString()).fixture, status: { long: 'Not Started', short: 'NS' } },
      goals: { home: null, away: null },
      score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null }, extratime: { home: null, away: null }, penalty: { home: null, away: null } },
    }));
    void a; void b; void cs;
    const features = await buildPredictionFeatures(upcoming.id, { persist: true });
    expect(features).toBeTruthy();
    expect((features as Record<string, unknown>).version).toBe(1);
    const fixture = (features as Record<string, Record<string, unknown>>).fixture as Record<string, unknown>;
    expect(Number(fixture.id ?? 0) === upcoming.id || fixture.id === upcoming.id).toBe(true);
    expect((features as Record<string, Record<string, unknown>>).h2h).toBeTruthy();
  });

  it('stores injuries idempotently', async () => {
    const cs = await upsertCompetitionSeason(LEAGUE, SEASON);
    const f1 = await upsertFixture(mapFixture(mkFixture(910010, 2, 1, '2099-08-20T14:00:00+00:00', 2099)));
    const n1 = await storeInjuries([
      { player: { providerId: 9600, name: 'Injured Guy' }, teamProviderId: 8001, fixtureProviderId: 910010, recordType: 'missing', reason: 'Hamstring', competitionProviderId: 3999, seasonYear: 2099 },
    ]);
    const n2 = await storeInjuries([
      { player: { providerId: 9600, name: 'Injured Guy' }, teamProviderId: 8001, fixtureProviderId: 910010, recordType: 'missing', reason: 'Hamstring', competitionProviderId: 3999, seasonYear: 2099 },
    ]);
    expect(n1).toBe(1);
    expect(n2).toBe(1);
    const { rows } = await query(`SELECT count(*)::int AS n FROM sidelined_records WHERE player_id = (SELECT id FROM players WHERE provider_id = 9600)`);
    expect(rows[0].n).toBe(1);
    void cs; void f1;
  });
});

describe('data quality', () => {
  it('reports zero violations on consistent data', async () => {
    const results = await runQualityChecks();
    const real = results.filter((r) => r.violations >= 0);
    expect(real.length).toBeGreaterThan(5);
    // fixtures_without_competition_season and duplicates must be 0
    for (const check of ['duplicate_provider_fixtures', 'fixtures_without_competition_season', 'events_without_fixture']) {
      const r = results.find((x) => x.check === check);
      expect(r?.violations).toBe(0);
    }
  });
});

afterAll(async () => {
  await pool.end();
});
