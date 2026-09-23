import { describe, it, expect } from 'vitest';
import { mapCompetition, mapSeasons, mapCoverage } from '../../src/mapping/leagues.js';
import { mapTeam, mapVenue } from '../../src/mapping/teams.js';
import { mapFixture, mapEvents, mapTeamStats, mapStandings, mapLineups, mapInjuries, isLiveStatus } from '../../src/mapping/fixtures.js';
import type { AFLeague, AFFixtureResponse } from '../../src/provider/types.js';

const league: AFLeague = {
  id: 39,
  name: 'Premier League',
  type: 'League',
  logo: 'https://logo.png',
  country: { id: 1, name: 'England', code: 'EN', flag: 'flag.png' },
  seasons: [
    {
      year: 2025,
      start: '2025-08-01',
      end: '2026-05-31',
      current: true,
      coverage: { events: true, lineups: true, statistics_fixtures: true, standings: true, top_scorers: true },
    },
    {
      year: 2024,
      start: '2024-08-01',
      end: '2025-05-31',
      current: false,
      coverage: { events: false, standings: true },
    },
  ],
};

describe('leagues mapping', () => {
  it('maps competition', () => {
    const c = mapCompetition(league);
    expect(c.providerId).toBe(39);
    expect(c.name).toBe('Premier League');
    expect(c.type).toBe('league'); // 'League' normalized
    expect(c.country?.name).toBe('England');
  });

  it('maps seasons with coverage flags', () => {
    const seasons = mapSeasons(league);
    expect(seasons).toHaveLength(2);
    expect(seasons[0].isCurrent).toBe(true);
    const cov = mapCoverage(league.seasons![0].coverage);
    expect(cov.events).toBe(true);
    expect(cov.standings).toBe(true);
    expect(cov.odds).toBe(false); // not provided -> false, never fabricated
  });
});

describe('teams mapping', () => {
  it('maps team + venue', () => {
    const t = mapTeam({
      id: 50,
      name: 'Manchester City',
      code: 'MCI',
      country: 'England',
      founded: 1880,
      national: false,
      venue: { id: 555, name: 'Etihad Stadium', city: 'Manchester', capacity: 55017, surface: 'grass' },
    });
    expect(t.providerId).toBe(50);
    expect(t.founded).toBe(1880);
    expect(t.venue?.providerId).toBe(555);
    expect(t.venue?.capacity).toBe(55017);
  });

  it('handles missing venue gracefully', () => {
    expect(mapVenue(null)).toBeNull();
    expect(mapVenue({})).toBeNull();
  });
});

const fixtureResponse: AFFixtureResponse = {
  fixture: {
    id: 1035048,
    referee: 'Michael Oliver, England',
    timezone: 'UTC',
    date: '2025-08-16T14:00:00+00:00',
    timestamp: 1755352800,
    venue: { id: 494, name: 'Old Trafford', city: 'Manchester' },
    status: { long: 'Match Finished', short: 'FT', elapsed: 90 },
  },
  league: { id: 39, name: 'Premier League', season: 2025, round: 'Regular Season - 1' },
  teams: {
    home: { id: 33, name: 'Manchester United', code: 'MUN' },
    away: { id: 40, name: 'Liverpool', code: 'LIV' },
  },
  goals: { home: 2, away: 1 },
  score: {
    halftime: { home: 1, away: 0 },
    fulltime: { home: 2, away: 1 },
    extratime: { home: null, away: null },
    penalty: { home: null, away: null },
  },
};

describe('fixtures mapping', () => {
  it('maps fixture with derived flags', () => {
    const f = mapFixture(fixtureResponse);
    expect(f.providerId).toBe(1035048);
    expect(f.isFinished).toBe(true);
    expect(f.postponed).toBe(false);
    expect(f.winnerProviderId).toBe(33);
    expect(f.referee?.name).toBe('Michael Oliver');
    expect(f.referee?.country).toBe('England');
    expect(f.ht).toEqual([1, 0]);
    expect(f.ft).toEqual([2, 1]);
  });

  it('live status detection', () => {
    expect(isLiveStatus('1H')).toBe(true);
    expect(isLiveStatus('HT')).toBe(true);
    expect(isLiveStatus('FT')).toBe(false);
    expect(isLiveStatus('NS')).toBe(false);
  });

  it('postponed/cancelled mapping', () => {
    const p = mapFixture({
      ...fixtureResponse,
      fixture: { ...fixtureResponse.fixture, status: { long: 'Postponed', short: 'PST' } },
      goals: { home: null, away: null },
    });
    expect(p.postponed).toBe(true);
    expect(p.isFinished).toBe(false);
  });

  it('event keys are stable for identical events', () => {
    const events = [
      { time: { elapsed: 12 }, team: { id: 33 }, player: { id: 901, name: 'Bruno' }, type: 'Card', detail: 'Yellow Card' },
      { time: { elapsed: 44 }, team: { id: 40 }, player: { id: 902, name: 'Salah' }, assist: { id: 903, name: 'Mac' }, type: 'Goal', detail: 'Normal Goal' },
    ];
    const mapped1 = mapEvents(1035048, events);
    const mapped2 = mapEvents(1035048, events);
    expect(mapped1.map((e) => e.eventKey)).toEqual(mapped2.map((e) => e.eventKey));
    expect(mapped1[1].assistProviderId).toBe(903);
  });

  it('team stats parse percentages and keep raw', () => {
    const rows = mapTeamStats([
      {
        team: { id: 33, name: 'Manchester United' },
        statistics: [
          { type: 'Total Shots', value: 15 },
          { type: 'Ball Possession', value: '58%' },
          { type: 'Passes %', value: '84%' },
          { type: 'expected_goals', value: 2.35 },
        ],
      },
    ]);
    expect(rows[0].shotsTotal).toBe(15);
    expect(rows[0].possessionPct).toBe(58);
    expect(rows[0].passAccuracyPct).toBe(84);
    expect(rows[0].expectedGoals).toBeCloseTo(2.35);
    expect(rows[0].raw['Ball Possession']).toBe('58%');
  });

  it('standings mapping with home/away split', () => {
    const rows = mapStandings([
      {
        rank: 1,
        team: { id: 33, name: 'Manchester United' },
        points: 40,
        goalsDiff: 15,
        group: 'Premier League',
        form: 'WWDLW',
        description: 'Promotion to Champions League',
        all: { played: 20, win: 12, draw: 4, lose: 4, goals: { for: 38, against: 23 } },
        home: { played: 10, win: 8, draw: 1, lose: 1, goals: { for: 24, against: 9 } },
        away: { played: 10, win: 4, draw: 3, lose: 3, goals: { for: 14, against: 14 } },
      },
    ]);
    expect(rows[0].groupName).toBe('Premier League');
    expect(rows[0].home?.win).toBe(8);
    expect(rows[0].goalsFor).toBe(38);
  });

  it('lineups mapping separates starters and subs', () => {
    const lineups = mapLineups([
      {
        team: { id: 33, name: 'Manchester United' },
        coach: { id: 5, name: 'Coach A' },
        formation: '4-2-3-1',
        startXI: [{ id: 1, name: 'GK One', number: 1, pos: 'G', grid: '0:0' }],
        substitutes: [{ id: 2, name: 'Sub One', number: 12, pos: 'F', grid: null }],
      },
    ]);
    expect(lineups[0].formation).toBe('4-2-3-1');
    expect(lineups[0].players.filter((p) => p.isStarting)).toHaveLength(1);
    expect(lineups[0].players.filter((p) => !p.isStarting)).toHaveLength(1);
  });

  it('injuries mapping normalizes type', () => {
    const rows = mapInjuries([
      { fixture: { id: 100 }, league: { id: 39, season: 2025 }, team: { id: 33, name: 'MU' }, player: { id: 9, name: 'P' }, type: 'Missing Fixture', reason: 'Knee Injury' },
    ]);
    expect(rows[0].recordType).toBe('missing');
    expect(rows[0].fixtureProviderId).toBe(100);
  });
});
