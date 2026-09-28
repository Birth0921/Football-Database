/**
 * MockFootballProvider — deterministic synthetic API-Football for local/dev/test.
 *
 * IMPORTANT: This provider generates SYNTHETIC data (obviously fictional teams and
 * players) so the full pipeline can be verified without live credentials. It never
 * fabricates real-world football data. When API_FOOTBALL_KEY is configured the live
 * ApiFootballClient is used instead (see src/provider/client.ts).
 *
 * It mimics api-sports v3 endpoints/params/response shapes, including partial
 * coverage (cup competitions without standings/players, one season without player
 * stats, one league without odds) so coverage-gating is exercised.
 */
import { ProviderRequestResult, ProviderResponse } from '../types.js';
import type { FootballProvider } from './client.js';
import { storeRawPayload } from './rawstore.js';
import { quotaManager } from '../sync/quota.js';
import { query } from '../lib/db.js';
import { paramStringHash } from '../lib/hash.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = (seed: string) => mulberry32(hashSeed(seed));
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Synthetic world
// ---------------------------------------------------------------------------
const FIRST = ['Alex', 'Ben', 'Carl', 'Dylan', 'Erik', 'Felix', 'Gustav', 'Hugo', 'Ivan', 'Jonas', 'Karim', 'Luca', 'Marco', 'Nils', 'Omar', 'Pedro', 'Quinn', 'Ravi', 'Sam', 'Theo', 'Ugo', 'Viktor', 'Wes', 'Xavi', 'Yann', 'Zane'];
const LAST = ['Adams', 'Baker', 'Costa', 'Dalton', 'Eriksen', 'Fischer', 'Grimaldi', 'Hansen', 'Ibrahim', 'Jensen', 'Kovac', 'Larsen', 'Moreno', 'Novak', 'Olsen', 'Pereira', 'Quintana', 'Rossi', 'Silva', 'Torres', 'Ustinov', 'Valenti', 'Walsh', 'Yilmaz', 'Zamora'];
const REFEREE_FIRST = ['Michael', 'Antonio', 'Klaus', 'Pierre', 'Sergio', 'Andrew'];
const REFEREE_LAST = ['Bridge', 'Conti', 'Dortmund', 'Fournier', 'Marquez', 'Wallace'];

interface Comp {
  id: number;
  name: string;
  code: string;
  type: 'League' | 'Cup';
  country: string;
  countryCode: string;
  flag: string;
  logo: string;
  isNational: boolean;
  teamCount: number;
  coverage: {
    standings: boolean;
    players: boolean;
    events: boolean;
    lineups: boolean;
    fixtureStatistics: boolean;
    playerStatistics: (season: number) => boolean;
    injuries: boolean;
    transfers: boolean;
    odds: boolean;
    referees: boolean;
  };
}

const COMPS: Comp[] = [
  {
    id: 39, name: 'Premier Division', code: 'PD', type: 'League', country: 'Northland', countryCode: 'NOR', isNational: true, teamCount: 8,
    flag: 'https://flags.example/northland.png', logo: 'https://logos.example/pd.png',
    coverage: {
      standings: true, players: true, events: true, lineups: true, fixtureStatistics: true,
      playerStatistics: () => true, injuries: true, transfers: true, odds: true, referees: true,
    },
  },
  {
    id: 140, name: 'Iberian League', code: 'IL', type: 'League', country: 'Southland', countryCode: 'SOU', isNational: true, teamCount: 8,
    flag: 'https://flags.example/southland.png', logo: 'https://logos.example/il.png',
    coverage: {
      standings: true, players: true, events: true, lineups: true, fixtureStatistics: true,
      playerStatistics: () => true, injuries: true, transfers: true, odds: false, referees: true,
    },
  },
  {
    id: 40, name: 'Second Division', code: 'SD', type: 'League', country: 'Northland', countryCode: 'NOR', isNational: true, teamCount: 8,
    flag: 'https://flags.example/northland.png', logo: 'https://logos.example/sd.png',
    coverage: {
      standings: true, players: true, events: true, lineups: true, fixtureStatistics: true,
      playerStatistics: (season) => season >= 2024, injuries: false, transfers: true, odds: true, referees: true,
    },
  },
  {
    id: 758, name: 'National Cup', code: 'NC', type: 'Cup', country: 'Southland', countryCode: 'SOU', isNational: true, teamCount: 8,
    flag: 'https://flags.example/southland.png', logo: 'https://logos.example/nc.png',
    coverage: {
      standings: false, players: false, events: true, lineups: true, fixtureStatistics: true,
      playerStatistics: () => true, injuries: false, transfers: false, odds: false, referees: true,
    },
  },
];

const TEAM_NAMES: Record<number, string[]> = {
  39: ['Northcastle FC', 'Westport United', 'Kingsbridge City', 'Riverside FC', 'Southend Athletic', 'Eastborough Town', 'Harborview FC', 'Meadowfield United'],
  140: ['Capital Sol FC', 'Seaside Blau', 'Valencia Rojo', 'Montaña CF', 'Isla Verde FC', 'Puerto Azul', 'Gran Sierra CF', 'Llanura United'],
  40: ['Ironhill Town', 'Lakeside FC', 'Foxbridge United', 'Redcliff Athletic', 'Stonehaven FC', 'Brookmere Town', 'Clearwater FC', 'Ashford Park'],
  758: ['Capital Sol FC', 'Seaside Blau', 'Valencia Rojo', 'Montaña CF', 'Isla Verde FC', 'Puerto Azul', 'Gran Sierra CF', 'Llanura United'],
};

const SEASONS = [2022, 2023, 2024, 2025, 2026];
const CURRENT_SEASON = 2026;
const NOW = () => new Date();

interface WTeam { id: number; name: string; code: string; compId: number; country: string; founded: number; venueId: number; venueName: string; city: string }
interface WPlayer { id: number; teamId: number; name: string; firstname: string; lastname: string; number: number; position: string; age: number }
interface WReferee { id: number; name: string; nationality: string }
interface WFixture {
  id: number; compId: number; season: number; round: string; roundNumber: number;
  date: string; homeId: number; awayId: number; refereeId: number;
  statusShort: string; statusLong: string; elapsed: number | null;
  hg: number | null; ag: number | null; hth: number | null; hta: number | null;
}

class World {
  teams = new Map<number, WTeam>();
  players = new Map<number, WPlayer[]>();
  referees = new Map<string, WReferee[]>(); // country → refs
  fixtures: WFixture[] = [];
  fixtureById = new Map<number, WFixture>();

  constructor() {
    let teamSeq = 100;
    let playerSeq = 10_000;
    let refSeq = 500;
    let fixtureSeq = 1_000_000;

    for (const comp of COMPS) {
      const r = rnd(`teams:${comp.id}`);
      const names = TEAM_NAMES[comp.id];
      const teamIds: number[] = [];
      names.forEach((name, i) => {
        const id = ++teamSeq;
        teamIds.push(id);
        this.teams.set(id, {
          id, name, code: name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(), compId: comp.id,
          country: comp.country, founded: 1880 + int(r, 0, 100),
          venueId: 1000 + id, venueName: `${name.split(' ')[0]} Park`, city: `City-${i + 1}`,
        });
        const squad: WPlayer[] = [];
        for (let p = 0; p < 22; p++) {
          const fn = pick(r, FIRST);
          const ln = pick(r, LAST);
          squad.push({
            id: ++playerSeq, teamId: id, name: `${fn} ${ln}`, firstname: fn, lastname: ln,
            number: p + 1,
            position: p === 0 ? 'Goalkeeper' : p <= 4 ? 'Defender' : p <= 10 ? 'Midfielder' : p <= 15 ? 'Attacker' : ['Goalkeeper', 'Defender', 'Midfielder', 'Attacker'][p % 4],
            age: int(r, 18, 35),
          });
        }
        this.players.set(id, squad);
      });

      const refs: WReferee[] = [];
      for (let i = 0; i < 6; i++) {
        // unique names per referee — fixtures reference referees by display name
        // (API-Football behaviour), so names must not collide.
        const first = REFEREE_FIRST[(refSeq + i) % REFEREE_FIRST.length];
        const last = REFEREE_LAST[(refSeq * 3 + i * 7) % REFEREE_LAST.length];
        refs.push({
          id: ++refSeq,
          name: `${first} ${String.fromCharCode(65 + (refSeq % 26))}. ${last}`,
          nationality: comp.country,
        });
      }
      this.referees.set(comp.country, [...(this.referees.get(comp.country) ?? []), ...refs]);

      for (const season of SEASONS) {
        if (comp.type === 'League') {
          // double round robin
          const rr = roundRobin(teamIds);
          let roundNum = 0;
          for (const roundMatches of rr) {
            roundNum += 1;
            roundMatches.forEach(([h, a], idx) => {
              const date = seasonKickoffDate(season, roundNum, idx);
              const fx = this.makeFixture(rnd(`fx:${comp.id}:${season}:${roundNum}:${idx}`), {
                id: ++fixtureSeq, compId: comp.id, season, round: `Regular Season - ${roundNum}`, roundNumber: roundNum,
                date, homeId: h, awayId: a,
              });
              this.fixtures.push(fx);
            });
          }
        } else {
          // cup: QF (4) -> SF (2) -> Final (1)
          const shuffled = [...teamIds].sort(() => rnd(`cup:${season}`)() - 0.5);
          const pairs: [number, number][] = [];
          for (let i = 0; i < 8; i += 2) pairs.push([shuffled[i], shuffled[i + 1]]);
          let fid = ++fixtureSeq;
          const qf: number[][] = [];
          pairs.forEach(([h, a], idx) => {
            const date = seasonKickoffDate(season, 18, idx);
            const fx = this.makeFixture(rnd(`fx:${comp.id}:${season}:Q${idx}`), {
              id: fid++, compId: comp.id, season, round: 'Quarter-finals', roundNumber: 1, date, homeId: h, awayId: a,
            });
            this.fixtures.push(fx);
            qf.push([fx.homeId, fx.awayId, fx.id]);
          });
          const semiPairs: [number, number][] = [
            [winner(qf[0]), winner(qf[1])],
            [winner(qf[2]), winner(qf[3])],
          ];
          semiPairs.forEach(([h, a], idx) => {
            const date = seasonKickoffDate(season, 32, idx);
            const fx = this.makeFixture(rnd(`fx:${comp.id}:${season}:S${idx}`), {
              id: fid++, compId: comp.id, season, round: 'Semi-finals', roundNumber: 2, date, homeId: h, awayId: a,
            });
            this.fixtures.push(fx);
            qf.push([fx.homeId, fx.awayId, fx.id]);
          });
          const finalA = winner(qf[4]);
          const finalB = winner(qf[5]);
          const date = seasonKickoffDate(season, 40, 0);
          const fx = this.makeFixture(rnd(`fx:${comp.id}:${season}:F`), {
            id: fid++, compId: comp.id, season, round: 'Final', roundNumber: 3, date, homeId: finalA, awayId: finalB,
          });
          this.fixtures.push(fx);
        }
      }
    }

    for (const f of this.fixtures) this.fixtureById.set(f.id, f);

    function winner(t: number[]): number {
      const h = t[0], a = t[1], id = t[2];
      const r = rnd(`win:${id}`);
      return r() < 0.5 ? h : a;
    }
  }

  private makeFixture(
    r: () => number,
    base: { id: number; compId: number; season: number; round: string; roundNumber: number; date: string; homeId: number; awayId: number },
  ): WFixture {
    const comp = COMPS.find((c) => c.id === base.compId)!;
    const refs = this.referees.get(comp.country)!;
    const refereeId = refs[int(r, 0, refs.length - 1)].id;
    const kickoff = new Date(base.date);
    const now = NOW();

    let statusShort = 'NS';
    let statusLong = 'Not Started';
    let elapsed: number | null = null;
    let hg: number | null = null;
    let ag: number | null = null;
    let hth: number | null = null;
    let hta: number | null = null;

    const diffMs = kickoff.getTime() - now.getTime();
    const hoursAfter = -diffMs / 36e5;

    if (hoursAfter > 3) {
      statusShort = base.season === CURRENT_SEASON && hoursAfter < 5 && r() < 0.35 ? 'LIVE' : 'FT';
      if (statusShort === 'LIVE') {
        statusLong = 'Second Half';
        elapsed = int(r, 48, 85);
        hg = poisson(r, 1.2);
        ag = poisson(r, 1.0);
        hth = Math.max(0, hg - (r() < 0.5 ? 1 : 0));
        hta = Math.max(0, ag - (r() < 0.4 ? 1 : 0));
        if (statusShort === 'LIVE') {
          statusShort = elapsed < 46 ? '1H' : elapsed === 46 ? 'HT' : '2H';
          statusLong = statusShort === '1H' ? 'First Half' : statusShort === 'HT' ? 'Halftime' : 'Second Half';
        }
      } else {
        statusLong = 'Match Finished';
        hg = poisson(r, 1.45);
        ag = poisson(r, 1.15);
        hth = poisson(r, 0.65);
        hta = poisson(r, 0.5);
        hth = Math.min(hth, hg);
        hta = Math.min(hta, ag);
      }
    } else {
      statusShort = 'NS';
      statusLong = 'Not Started';
    }

    return {
      ...base, refereeId, statusShort, statusLong, elapsed,
      hg, ag, hth, hta,
    };
  }

  teamsForLeague(leagueId: number, season: number): WTeam[] {
    void season;
    return [...this.teams.values()].filter((t) => t.compId === leagueId);
  }

  squadFor(teamId: number): WPlayer[] {
    return this.players.get(teamId) ?? [];
  }
}

/** Simple round robin (double) over team ids. */
function roundRobin(ids: number[]): [number, number][][] {
  const n = ids.length;
  const rounds: [number, number][][] = [];
  const arr = [...ids];
  for (let r = 0; r < n - 1; r++) {
    const matches: [number, number][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      matches.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(matches);
    arr.splice(1, 0, arr.pop()!);
  }
  const second = rounds.map((m) => m.map(([a, b]) => [b, a] as [number, number]));
  return [...rounds, ...second];
}

function seasonKickoffDate(season: number, round: number, idx: number): string {
  // Season starts first Saturday of August; one round per week.
  const start = new Date(Date.UTC(season, 7, 3));
  const d = new Date(start.getTime() + (round - 1) * 7 * 864e5);
  d.setUTCHours(idx % 2 === 0 ? 14 : 17, idx % 4 === 0 ? 0 : 30, 0, 0);
  return d.toISOString();
}

function poisson(r: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= r();
  } while (p > L);
  return k - 1;
}

// ---------------------------------------------------------------------------
// Fixture detail generation (deterministic per fixture id)
// ---------------------------------------------------------------------------
function fxDetails(f: WFixture) {
  const world = getWorld();
  const r = rnd(`detail:${f.id}`);
  const home = world.teams.get(f.homeId)!;
  const away = world.teams.get(f.awayId)!;
  const comp = COMPS.find((c) => c.id === f.compId)!;
  const finished = ['FT', 'AET', 'PEN'].includes(f.statusShort);
  const live = ['1H', 'HT', '2H', 'ET', 'P'].includes(f.statusShort);

  // events
  const events: unknown[] = [];
  if (f.hg != null && f.ag != null) {
    const mkGoal = (teamId: number, scored: number, side: 'home' | 'away') => {
      const squad = world.squadFor(teamId);
      for (let g = 0; g < scored; g++) {
        const scorer = pick(r, squad.filter((p) => p.position !== 'Goalkeeper'));
        const ass = pick(r, squad);
        const minute = int(r, 3, finished ? 92 : Math.max(f.elapsed ?? 1, 3));
        events.push({
          time: { elapsed: minute, extra: r() < 0.12 ? int(r, 1, 8) : null },
          team: { id: teamId, name: side === 'home' ? home.name : away.name },
          player: { id: scorer.id, name: scorer.name },
          assist: r() < 0.7 ? { id: ass.id, name: ass.name } : { id: null, name: null },
          type: 'Goal',
          detail: r() < 0.08 ? 'Own Goal' : r() < 0.12 ? 'Penalty' : 'Normal Goal',
          comments: null,
        });
      }
    };
    mkGoal(f.homeId, f.hg, 'home');
    mkGoal(f.awayId, f.ag, 'away');
    // cards + subs
    for (const [teamId, side] of [[f.homeId, 'home'], [f.awayId, 'away']] as [number, string][]) {
      const squad = world.squadFor(teamId);
      const yellows = int(r, 0, 4);
      for (let i = 0; i < yellows; i++) {
        const p = pick(r, squad);
        events.push({
          time: { elapsed: int(r, 10, 92), extra: null },
          team: { id: teamId, name: side === 'home' ? home.name : away.name },
          player: { id: p.id, name: p.name },
          assist: { id: null, name: null },
          type: 'Card',
          detail: r() < 0.05 ? 'Red Card' : 'Yellow Card',
          comments: null,
        });
      }
      if (r() < 0.08) {
        const p = pick(r, squad);
        events.push({
          time: { elapsed: int(r, 40, 90), extra: null },
          team: { id: teamId, name: side === 'home' ? home.name : away.name },
          player: { id: p.id, name: p.name },
          assist: { id: null, name: null },
          type: 'Card', detail: 'Second Yellow card', comments: null,
        });
      }
      const subs = int(r, 2, 5);
      for (let i = 0; i < subs; i++) {
        const out = pick(r, squad.slice(0, 11));
        const inn = pick(r, squad.slice(11));
        events.push({
          time: { elapsed: int(r, 55, 88), extra: null },
          team: { id: teamId, name: side === 'home' ? home.name : away.name },
          player: { id: inn.id, name: inn.name },
          assist: { id: out.id, name: out.name },
          type: 'subst',
          detail: 'Substitution 1', comments: null,
        });
      }
      if (r() < 0.15) {
        const p = pick(r, squad);
        events.push({
          time: { elapsed: int(r, 20, 90), extra: null },
          team: { id: teamId, name: side === 'home' ? home.name : away.name },
          player: { id: p.id, name: p.name },
          assist: { id: null, name: null },
          type: 'Var', detail: pick(r, ['Penalty cancelled', 'Goal confirmed', 'Red card cancelled']), comments: 'VAR decision',
        });
      }
    }
  }
  events.sort((a, b) => {
    const ta = (a as { time: { elapsed: number } }).time.elapsed;
    const tb = (b as { time: { elapsed: number } }).time.elapsed;
    return ta - tb;
  });

  // team statistics
  const teamStats = (teamId: number, goals: number | null, isHome: boolean) => {
    const possession = int(r, isHome ? 44 : 38, isHome ? 66 : 58);
    const shots = int(r, 5, 20) + (goals ?? 0);
    const sot = Math.min(shots, int(r, 2, 8) + (goals ?? 0));
    return {
      team: { id: teamId, name: teamId === f.homeId ? home.name : away.name },
      statistics: [
        { type: 'Shots on Goal', value: sot },
        { type: 'Shots off Goal', value: int(r, 1, Math.max(shots - sot, 2)) },
        { type: 'Total Shots', value: shots },
        { type: 'Blocked Shots', value: int(r, 0, 6) },
        { type: 'Shots insidebox', value: int(r, 2, 12) },
        { type: 'Shots outsidebox', value: int(r, 0, 6) },
        { type: 'Fouls', value: int(r, 6, 18) },
        { type: 'Corner Kicks', value: int(r, 2, 12) },
        { type: 'Offsides', value: int(r, 0, 6) },
        { type: 'Ball Possession', value: `${isHome ? possession : 100 - possession}%` },
        { type: 'Yellow Cards', value: int(r, 0, 4) },
        { type: 'Red Cards', value: r() < 0.04 ? 1 : 0 },
        { type: 'Goalkeeper Saves', value: int(r, 1, 7) },
        { type: 'Total passes', value: int(r, 250, 650) },
        { type: 'Passes accurate', value: int(r, 180, 560) },
        { type: 'Passes %', value: `${int(r, 65, 91)}%` },
        { type: 'expected_goals', value: (Math.round(r() * 3.2 * 100) / 100).toFixed(2) },
        { type: 'Crosses', value: int(r, 5, 25) },
        { type: 'Crosses Accurate', value: int(r, 1, 12) },
        { type: 'Tackles', value: int(r, 8, 28) },
        { type: 'Interceptions', value: int(r, 5, 20) },
        { type: 'Clearances', value: int(r, 8, 35) },
        { type: 'Blocks', value: int(r, 1, 10) },
        { type: 'Duels', value: int(r, 60, 130) },
        { type: 'Duels Won', value: int(r, 30, 75) },
        { type: 'Aerial Duels', value: int(r, 15, 45) },
        { type: 'Aerial Duels Won', value: int(r, 6, 26) },
        { type: 'Dribbles', value: int(r, 8, 28) },
        { type: 'Dribbles Success', value: int(r, 3, 16) },
      ],
    };
  };

  // player statistics + lineups
  const players = (teamId: number) => {
    const squad = world.squadFor(teamId);
    const starting = squad.slice(0, 11);
    const bench = squad.slice(11, 18);
    return {
      team: { id: teamId, name: teamId === f.homeId ? home.name : away.name },
      players: [
        ...starting.map((p) => ({ player: playerInfo(p), statistics: [playerStatsLine(r, p, false, f)] })),
        ...bench.slice(0, int(r, 2, 5)).map((p) => ({ player: playerInfo(p), statistics: [playerStatsLine(r, p, true, f)] })),
      ],
    };
  };

  const lineups = (teamId: number) => {
    const squad = world.squadFor(teamId);
    const coachName = `${pick(r, FIRST)} ${pick(r, LAST)}`;
    return {
      team: { id: teamId, name: teamId === f.homeId ? home.name : away.name },
      coach: { id: null, name: coachName, photo: null },
      formation: pick(r, ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1', '5-3-2']),
      startXI: squad.slice(0, 11).map((p, i) => ({ player: { id: p.id, name: p.name, number: p.number, pos: p.position[0], grid: `${Math.floor(i / 5) + 1}:${(i % 5) + 1}` } })),
      substitutes: squad.slice(11, 18).map((p) => ({ player: { id: p.id, name: p.name, number: p.number, pos: p.position[0], grid: null } })),
    };
  };

  return {
    comp, home, away, finished, live,
    events,
    statistics: comp.coverage.fixtureStatistics
      ? [teamStats(f.homeId, f.hg ?? null, true), teamStats(f.awayId, f.ag ?? null, false)]
      : [],
    playersEntries: comp.coverage.playerStatistics(f.season) && (finished || live)
      ? [players(f.homeId), players(f.awayId)]
      : [],
    lineups: comp.coverage.lineups && (finished || live) ? [lineups(f.homeId), lineups(f.awayId)] : [],
  };
}

function playerInfo(p: WPlayer) {
  return {
    id: p.id, name: p.name, firstname: p.firstname, lastname: p.lastname, age: p.age,
    birth: { date: `${2026 - p.age}-0${(p.id % 8) + 1}-1${p.id % 9}`, place: null, country: null },
    nationality: p.teamId ? 'Northland' : null,
    height: `${170 + (p.id % 30)} cm`, weight: `${65 + (p.id % 25)} kg`,
    injured: false, photo: `https://img.example/players/${p.id}.png`,
  };
}

function playerStatsLine(r: () => number, p: WPlayer, sub: boolean, f: WFixture) {
  const minutes = sub ? int(r, 5, 35) : int(r, 55, 90);
  const goals = r() < 0.12 ? 1 : 0;
  return {
    team: { id: p.teamId, name: null },
    games: {
      minutes, number: p.number, position: p.position[0],
      rating: (6 + r() * 3.2).toFixed(1),
      captain: p.number === 1 && !sub, substitute: sub,
    },
    shots: { total: int(r, 0, 5), on: int(r, 0, 3) },
    goals: { total: goals, conceded: p.position === 'Goalkeeper' ? (p.teamId === f.homeId ? f.ag ?? 0 : f.hg ?? 0) : 0, assists: r() < 0.08 ? 1 : 0, saves: p.position === 'Goalkeeper' ? int(r, 1, 7) : null },
    passes: { total: int(r, 8, 90), key: int(r, 0, 5), accuracy: int(r, 60, 95) },
    tackles: { total: int(r, 0, 6), blocks: int(r, 0, 3), interceptions: int(r, 0, 4) },
    dribbles: { attempts: int(r, 0, 6), success: int(r, 0, 4), past: null },
    duels: { total: int(r, 2, 18), won: int(r, 1, 10) },
    fouls: { drawn: int(r, 0, 3), committed: int(r, 0, 3) },
    cards: { yellow: r() < 0.1 ? 1 : 0, yellowred: r() < 0.01 ? 1 : 0, red: r() < 0.01 ? 1 : 0 },
    penalty: { won: r() < 0.03 ? 1 : 0, committed: r() < 0.02 ? 1 : 0, scored: r() < 0.03 ? 1 : 0, missed: r() < 0.01 ? 1 : 0, saved: null },
  };
}

let world: World | null = null;
function getWorld(): World {
  if (!world) world = new World();
  return world;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------
export class MockFootballProvider implements FootballProvider {
  name = 'api-football';
  mode = 'mock' as const;

  async verifyCredentials(): Promise<{ ok: boolean; detail: string; quota?: unknown }> {
    const res = await this.get('/status', {});
    return {
      ok: true,
      detail: 'MOCK provider active (no API_FOOTBALL_KEY configured) — synthetic data only',
      quota: res.data.response[0] ?? null,
    };
  }

  async get<T = unknown>(endpoint: string, params: Record<string, unknown>): Promise<ProviderRequestResult<T>> {
    await quotaManager.waitForCapacity();
    const t0 = Date.now();
    const response = this.route(endpoint, params) as T[];
    const body: ProviderResponse<T> = {
      get: endpoint,
      parameters: Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])),
      errors: [],
      results: response.length,
      paging: { current: 1, total: 1 },
      response,
    };
    await quotaManager.recordUse(null, null);
    await storeRawPayload({ endpoint, params, entityType: endpoint.replace(/\W+/g, '_'), responseJson: body, httpStatus: 200 });
    await query(
      `INSERT INTO provider_requests
        (endpoint, http_method, request_param_hash, started_at, completed_at, duration_ms, http_status,
         success, cache_hit, daily_quota_remaining, minute_quota_remaining, sync_task, error_message)
       VALUES ($1, 'GET', $2, now() - ($3::int || ' ms')::interval, now(), $3::int, 200, true, false,
               (SELECT daily_remaining FROM provider_quota WHERE provider='api-football' AND day=(now() AT TIME ZONE 'utc')::date),
               (SELECT minute_remaining FROM provider_quota WHERE provider='api-football' AND day=(now() AT TIME ZONE 'utc')::date),
               $4, null)`,
      [endpoint, paramStringHash(params), Number(Date.now() - t0), (globalThis as { __syncTaskKey?: string }).__syncTaskKey ?? null],
    );
    return { data: body, httpStatus: 200, fromCache: false, dailyRemaining: null, minuteRemaining: null };
  }

  private route(endpoint: string, params: Record<string, unknown>): unknown[] {
    const w = getWorld();
    const season = Number(params.season ?? CURRENT_SEASON);
    const leagueId = Number(params.league ?? 0);
    const fixtureId = Number(params.fixture ?? params.id ?? 0);
    const teamId = Number(params.team ?? 0);
    const playerId = Number(params.player ?? 0);

    switch (endpoint) {
      case '/status':
        return [
          {
            account: { plan: 'Trial', requests: Math.min(config.providerDailyQuota - 1, 42 + (Date.now() % 1000)), 'day-sessions': 42, 'month-sessions': 500 },
            subscription: { started: '2026-01-01', end: '2027-01-01' },
          },
        ];

      case '/leagues': {
        if (params.id) {
          const comp = COMPS.find((c) => c.id === Number(params.id));
          return comp ? [{ country: { name: comp.country, code: comp.countryCode, flag: comp.flag }, league: compDto(comp), seasons: SEASONS.map(seasonDto) }] : [];
        }
        return COMPS.map((comp) => ({
          country: { name: comp.country, code: comp.countryCode, flag: comp.flag },
          league: compDto(comp),
          seasons: SEASONS.map(seasonDto),
        }));
      }

      case '/leagues/seasons':
        return SEASONS.map(seasonDto);

      case '/teams': {
        if (teamId) {
          const t = w.teams.get(teamId);
          return t ? [teamDto(t)] : [];
        }
        return w.teamsForLeague(leagueId, season).map(teamDto);
      }

      case '/players/squads': {
        if (teamId) {
          const t = w.teams.get(teamId);
          if (!t) return [];
          return [{ team: { id: t.id, name: t.name, logo: null }, players: w.squadFor(teamId).map((p) => ({ id: p.id, name: p.name, age: p.age, number: p.number, position: p.position, photo: null })) }];
        }
        return [];
      }

      case '/players': {
        const comp = COMPS.find((c) => c.id === leagueId);
        if (!comp || !comp.coverage.players || !comp.coverage.playerStatistics(season)) return [];
        const fixtures = w.fixtures.filter((f) => f.compId === leagueId && f.season === season && ['FT', 'AET', 'PEN'].includes(f.statusShort));
        const agg = new Map<number, { player: WPlayer; teamId: number; g: number; a: number; apps: number; mins: number }>();
        for (const f of fixtures.slice(0, 12)) {
          for (const pe of fxDetails(f).playersEntries as unknown as { team: { id: number }; players: { player: { id: number }; statistics: unknown[] }[] }[]) {
            for (const row of pe.players) {
              const pid = row.player.id;
              const player = w.squadFor(pe.team.id).find((p) => p.id === pid);
              if (!player) continue;
              const cur = agg.get(pid) ?? { player, teamId: pe.team.id, g: 0, a: 0, apps: 0, mins: 0 };
              const line = row.statistics[0] as ReturnType<typeof playerStatsLine>;
              cur.g += line.goals?.total ?? 0;
              cur.a += line.goals?.assists ?? 0;
              cur.apps += 1;
              cur.mins += line.games?.minutes ?? 0;
              agg.set(pid, cur);
            }
          }
        }
        return [...agg.values()].map((v) => ({
          player: playerInfo(v.player),
          statistics: [
            {
              team: { id: v.teamId, name: null, logo: null },
              league: { id: leagueId, name: comp.name, country: comp.country, season },
              games: { appearences: v.apps, lineups: v.apps, minutes: v.mins, position: v.player.position, rating: '7.0', captain: false },
              shots: { total: v.apps * 2, on: v.apps },
              goals: { total: v.g, conceded: 0, assists: v.a, saves: 0 },
              passes: { total: v.apps * 30, key: v.apps, accuracy: 80 },
              tackles: { total: v.apps, blocks: 0, interceptions: v.apps },
              dribbles: { attempts: v.apps, success: 1, past: null },
              duels: { total: v.apps * 4, won: v.apps * 2 },
              fouls: { drawn: 1, committed: 2 },
              cards: { yellow: 0, yellowred: 0, red: 0 },
              penalty: { won: 0, committed: 0, scored: 0, missed: 0, saved: null },
            },
          ],
        }));
      }

      case '/referees': {
        const comp = COMPS.find((c) => c.id === leagueId);
        if (!comp || !comp.coverage.referees) return [];
        return (w.referees.get(comp.country) ?? []).map((r) => ({
          id: r.id, name: r.name, firstname: r.name.split(' ')[0], lastname: r.name.split(' ').slice(1).join(' '),
          country: r.nationality, photo: null,
        }));
      }

      case '/fixtures/rounds': {
        const rounds = new Set(w.fixtures.filter((f) => f.compId === leagueId && f.season === season).map((f) => f.round));
        return [...rounds];
      }

      case '/fixtures': {
        if (params.live === 'true' || params.live === '1' || params.live === 'all') {
          return w.fixtures.filter((f) => ['1H', 'HT', '2H', 'ET', 'P'].includes(f.statusShort)).map((f) => fixtureDto(f, w));
        }
        if (fixtureId) {
          const f = w.fixtureById.get(fixtureId);
          return f ? [fixtureDto(f, w)] : [];
        }
        let list = w.fixtures;
        if (leagueId) list = list.filter((f) => f.compId === leagueId);
        if (season) list = list.filter((f) => f.season === season);
        if (params.date) list = list.filter((f) => f.date.slice(0, 10) === String(params.date));
        if (params.team) list = list.filter((f) => f.homeId === teamId || f.awayId === teamId);
        if (params.from) list = list.filter((f) => f.date.slice(0, 10) >= String(params.from));
        if (params.to) list = list.filter((f) => f.date.slice(0, 10) <= String(params.to));
        if (params.status) list = list.filter((f) => f.statusShort === String(params.status).toUpperCase());
        return list.map((f) => fixtureDto(f, w));
      }

      case '/fixtures/events': {
        const f = w.fixtureById.get(fixtureId);
        if (!f) return [];
        return fxDetails(f).events;
      }

      case '/fixtures/statistics': {
        const f = w.fixtureById.get(fixtureId);
        if (!f) return [];
        return fxDetails(f).statistics;
      }

      case '/fixtures/players': {
        const f = w.fixtureById.get(fixtureId);
        if (!f) return [];
        return fxDetails(f).playersEntries;
      }

      case '/fixtures/lineups': {
        const f = w.fixtureById.get(fixtureId);
        if (!f) return [];
        return fxDetails(f).lineups;
      }

      case '/standings': {
        const comp = COMPS.find((c) => c.id === leagueId);
        if (!comp || !comp.coverage.standings) return [];
        const fixtures = w.fixtures.filter((f) => f.compId === leagueId && f.season === season && ['FT', 'AET', 'PEN'].includes(f.statusShort));
        const table = new Map<number, { p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number; form: string[] }>();
        for (const t of w.teamsForLeague(leagueId, season)) {
          table.set(t.id, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, form: [] });
        }
        for (const f of fixtures) {
          const h = table.get(f.homeId);
          const a = table.get(f.awayId);
          if (!h || !a || f.hg == null || f.ag == null) continue;
          h.p++; a.p++;
          h.gf += f.hg; h.ga += f.ag;
          a.gf += f.ag; a.ga += f.hg;
          if (f.hg > f.ag) { h.w++; a.l++; h.pts += 3; h.form.push('W'); a.form.push('L'); }
          else if (f.hg < f.ag) { a.w++; h.l++; a.pts += 3; a.form.push('W'); h.form.push('L'); }
          else { h.d++; a.d++; h.pts++; a.pts++; h.form.push('D'); a.form.push('D'); }
        }
        const rows = [...table.entries()]
          .map(([teamId, s]) => ({
            rank: 0,
            team: { id: teamId, name: w.teams.get(teamId)!.name, code: null, logo: null, country: null, founded: null, national: null },
            points: s.pts,
            goalsDiff: s.gf - s.ga,
            group: comp.name,
            form: s.form.slice(-5).join(''),
            status: 'same',
            description: null,
            all: { played: s.p, win: s.w, draw: s.d, lose: s.l, goals: { for: s.gf, against: s.ga } },
            home: null,
            away: null,
            update: new Date().toISOString(),
          }))
          .sort((a, b) => b.points - a.points || b.goalsDiff - a.goalsDiff)
          .map((row, i) => ({ ...row, rank: i + 1 }));
        return [
          {
            league: {
              id: comp.id, name: comp.name, country: comp.country, logo: comp.logo, flag: comp.flag,
              season, standings: [rows],
            },
          },
        ];
      }

      case '/injuries': {
        const comp = COMPS.find((c) => c.id === (leagueId || 39));
        if (!comp?.coverage.injuries) return [];
        const teams = w.teamsForLeague(comp.id, season);
        const out: unknown[] = [];
        for (const t of teams.slice(0, 3)) {
          const p = w.squadFor(t.id)[3];
          out.push({
            player: playerInfo(p),
            team: { id: t.id, name: t.name },
            fixture: null,
            league: { id: comp.id, season },
            type: { reason: 'Hamstring injury', start: `${season + 1}-02-10`, end: null },
          });
        }
        return out;
      }

      case '/transfers': {
        const out: unknown[] = [];
        const teams = teamId ? [w.teams.get(teamId)].filter(Boolean) : [...w.teams.values()];
        for (const t of teams as WTeam[]) {
          const squad = w.squadFor(t.id);
          for (const p of squad.slice(18, 20)) {
            const other = [...w.teams.values()].find((x) => x.compId === t.compId && x.id !== t.id)!;
            out.push({
              player: { id: p.id, name: p.name },
              update: `${season}-01-15`,
              type: r_pick(p.id, t.id),
              date: `${season}-01-15`,
              teams: {
                in: { id: t.id, name: t.name },
                out: { id: other.id, name: other.name },
              },
            });
          }
        }
        if (playerId) return out.filter((o) => (o as { player: { id: number } }).player.id === playerId);
        return out;
      }

      case '/odds': {
        const comp = COMPS.find((c) => c.id === leagueId) ?? COMPS[0];
        if (!comp.coverage.odds) return [];
        // Odds preferred for not-started fixtures; fall back to recent fixtures so
        // capability detection stays accurate for completed seasons.
        let fixtures = w.fixtures.filter(
          (f) => f.compId === comp.id && f.season === season && (fixtureId ? f.id === fixtureId : f.statusShort === 'NS'),
        );
        if (fixtures.length === 0 && !fixtureId) {
          fixtures = w.fixtures.filter((f) => f.compId === comp.id && f.season === season).slice(-8);
        }
        return fixtures.slice(0, 8).map((f) => ({
          league: { id: comp.id, name: comp.name, season: f.season, country: comp.country, logo: comp.logo, flag: comp.flag },
          fixture: { id: f.id, date: f.date },
          update: new Date().toISOString(),
          bookmakers: [
            {
              id: 1, name: 'MockBet',
              bets: [
                {
                  id: 1, name: 'Match Winner',
                  values: [
                    { value: 'Home', odd: (1.5 + (f.id % 20) / 10).toFixed(2) },
                    { value: 'Draw', odd: (3.1 + (f.id % 10) / 10).toFixed(2) },
                    { value: 'Away', odd: (2.2 + (f.id % 15) / 10).toFixed(2) },
                  ],
                },
                {
                  id: 2, name: 'Goals Over/Under 2.5',
                  values: [
                    { value: 'Over', odd: '1.85' },
                    { value: 'Under', odd: '1.95' },
                  ],
                },
              ],
            },
          ],
        }));
      }

      case '/predictions':
        return [];

      default:
        return [];
    }
  }
}

function r_pick(pid: number, tid: number): string {
  const r = rnd(`tr:${pid}:${tid}`);
  return pick(r, ['Transfer', 'Loan', 'Free', 'N/A']);
}

function compDto(c: Comp) {
  return { id: c.id, name: c.name, code: c.code, type: c.type, logo: c.logo, is_national: c.isNational };
}

function seasonDto(y: number) {
  const start = `${y}-08-01`;
  const end = `${y + 1}-05-31`;
  return {
    year: y,
    start,
    end,
    current: y === CURRENT_SEASON,
    coverage: {},
    standings: true,
  };
}

function teamDto(t: WTeam) {
  return {
    id: t.id,
    name: t.name,
    code: t.code,
    country: t.country,
    founded: t.founded,
    national: false,
    logo: `https://img.example/teams/${t.id}.png`,
    venue: {
      id: t.venueId, name: t.venueName, address: null, city: t.city,
      capacity: 12000 + t.id, surface: 'grass', image: null,
    },
  };
}

function fixtureDto(f: WFixture, w: World) {
  const home = w.teams.get(f.homeId)!;
  const away = w.teams.get(f.awayId)!;
  const ref = [...w.referees.values()].flat().find((r) => r.id === f.refereeId);
  const comp = COMPS.find((c) => c.id === f.compId)!;
  return {
    id: f.id,
    referee: ref?.name ?? null,
    timezone: 'UTC',
    date: f.date,
    timestamp: Math.floor(new Date(f.date).getTime() / 1000),
    venue: { id: home.venueId, name: home.venueName, city: home.city, capacity: null, surface: null, image: null },
    status: { long: f.statusLong, short: f.statusShort, elapsed: f.elapsed, extra: null },
    league: { id: comp.id, name: comp.name, country: comp.country, logo: comp.logo, flag: comp.flag, season: f.season, round: f.round, type: comp.type, code: comp.code, is_national: comp.isNational },
    teams: {
      home: { id: home.id, name: home.name, code: home.code, country: home.country, founded: home.founded, national: false, logo: `https://img.example/teams/${home.id}.png`, winner: f.hg != null && f.ag != null ? f.hg > f.ag : null },
      away: { id: away.id, name: away.name, code: away.code, country: away.country, founded: away.founded, national: false, logo: `https://img.example/teams/${away.id}.png`, winner: f.hg != null && f.ag != null ? f.ag > f.hg : null },
    },
    goals: { home: f.hg, away: f.ag },
    score: {
      halftime: { home: f.hth, away: f.hta },
      fulltime: { home: ['FT', 'AET', 'PEN'].includes(f.statusShort) ? f.hg : null, away: ['FT', 'AET', 'PEN'].includes(f.statusShort) ? f.ag : null },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    periods: { first: null, second: null },
  };
}
