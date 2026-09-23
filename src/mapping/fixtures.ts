import type { AFFixtureResponse, AFEvent, AFTeamStats, AFPlayerStatistics, AFLineup, AFStandingRow, AFInjury, AFTransfer, AFOddsResponse, AFCoach, AFPlayer } from '../provider/types.js';
import { eventKey, parseIntOrNull, parseNumeric, parsePossession, splitNameCountry, nameKey, parseHeightToInt, parseWeightToInt } from '../util/hash.js';

// These interfaces describe rows passed into the repository upserts.
export interface FixtureRow {
  providerId: number;
  competitionProviderId: number;
  seasonYear: number;
  roundName: string | null;
  kickoffAt: string | null;
  kickoffDate: string | null;
  timezone: string | null;
  statusShort: string | null;
  statusLong: string | null;
  statusCode: number | null;
  statusElapsed: number | null;
  isFinished: boolean;
  postponed: boolean;
  cancelled: boolean;
  hasExtraTime: boolean;
  homeTeam: TeamRef;
  awayTeam: TeamRef;
  venue: { providerId: number | null; name: string | null; city: string | null } | null;
  referee: { name: string; country: string | null } | null;
  winnerProviderId: number | null;
  homeScore: number | null;
  awayScore: number | null;
  ht: [number | null, number | null];
  ft: [number | null, number | null];
  et: [number | null, number | null];
  pen: [number | null, number | null];
  providerUpdatedAt: string | null;
  raw: unknown;
}

export interface TeamRef { providerId: number; name: string; logo?: string | null }

const FINISHED_SHORT = new Set(['FT', 'AET', 'PEN']);
const CANCELLED_SHORT = new Set(['CANC', 'PST', 'ABD', 'SUSP', 'INT', 'AWD', 'WO']);
const LIVE_SHORT = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE']);

export function isLiveStatus(short: string | null | undefined): boolean {
  return Boolean(short && LIVE_SHORT.has(short));
}

export function mapFixture(f: AFFixtureResponse): FixtureRow {
  const status = f.fixture?.status ?? {};
  const statusShort = status.short ?? null;
  const isFinished = Boolean(statusShort && FINISHED_SHORT.has(statusShort));
  const cancelled = Boolean(statusShort && CANCELLED_SHORT.has(statusShort) && statusShort !== 'PST');
  const postponed = statusShort === 'PST';
  const goals = f.goals ?? { home: null, away: null };
  const score = f.score ?? {};
  const winnerProviderId =
    goals.home !== null && goals.away !== null && goals.home !== goals.away
      ? goals.home > goals.away
        ? f.teams?.home?.id ?? null
        : f.teams?.away?.id ?? null
      : null;

  return {
    providerId: f.fixture.id,
    competitionProviderId: f.league.id,
    seasonYear: f.league.season,
    roundName: f.league.round ?? null,
    kickoffAt: f.fixture.date ?? null,
    kickoffDate: f.fixture.date ? f.fixture.date.slice(0, 10) : null,
    timezone: f.fixture.timezone ?? null,
    statusShort,
    statusLong: status.long ?? null,
    statusCode: null,
    statusElapsed: status.elapsed ?? null,
    isFinished,
    postponed,
    cancelled,
    hasExtraTime: statusShort === 'AET' || statusShort === 'PEN' || (score.extratime?.home !== null && score.extratime?.home !== undefined),
    homeTeam: { providerId: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo ?? null },
    awayTeam: { providerId: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo ?? null },
    venue: f.fixture.venue
      ? { providerId: f.fixture.venue.id ?? null, name: f.fixture.venue.name ?? null, city: f.fixture.venue.city ?? null }
      : null,
    referee: splitNameCountry(f.fixture.referee ?? null),
    winnerProviderId,
    homeScore: goals.home,
    awayScore: goals.away,
    ht: [score.halftime?.home ?? null, score.halftime?.away ?? null],
    ft: [score.fulltime?.home ?? null, score.fulltime?.away ?? null],
    et: [score.extratime?.home ?? null, score.extratime?.away ?? null],
    pen: [score.penalty?.home ?? null, score.penalty?.away ?? null],
    providerUpdatedAt: null,
    raw: f,
  };
}

export interface EventRow {
  eventKey: string;
  teamProviderId: number | null;
  playerProviderId: number | null;
  assistProviderId: number | null;
  playerName: string | null;
  assistName: string | null;
  eventType: string;
  eventDetail: string | null;
  comments: string | null;
  minute: number | null;
  extraMinute: number | null;
  isVar: boolean;
  sortOrder: number;
  raw: unknown;
}

export function mapEvents(fixtureProviderId: number, events: AFEvent[]): EventRow[] {
  return (events ?? []).map((e, idx) => ({
    eventKey: eventKey([
      fixtureProviderId,
      e.team?.id ?? '',
      e.time?.elapsed ?? '',
      e.time?.extra ?? '',
      e.player?.id ?? e.player?.name ?? '',
      e.assist?.id ?? e.assist?.name ?? '',
      e.type,
      e.detail ?? '',
      e.comments ?? '',
      idx,
    ]),
    teamProviderId: e.team?.id ?? null,
    playerProviderId: e.player?.id ?? null,
    assistProviderId: e.assist?.id ?? null,
    playerName: e.player?.name ?? null,
    assistName: e.assist?.name ?? null,
    eventType: e.type ?? 'Unknown',
    eventDetail: e.detail ?? null,
    comments: e.comments ?? null,
    minute: parseIntOrNull(e.time?.elapsed),
    extraMinute: parseIntOrNull(e.time?.extra),
    isVar: /\bvar\b/i.test(e.detail ?? '') || Boolean(e.comments && /var/i.test(e.comments)),
    sortOrder: idx,
    raw: e,
  }));
}

const STAT_FIELDS: Record<string, string> = {
  'Total Shots': 'shotsTotal',
  'Shots on Goal': 'shotsOnGoal',
  'Shots off Goal': 'shotsOffGoal',
  'Blocked Shots': 'shotsBlocked',
  'Shots insidebox': 'shotsInsideBox',
  'Shots outsidebox': 'shotsOutsideBox',
  'Fouls': 'fouls',
  'Corner Kicks': 'corners',
  'Offsides': 'offsides',
  'Ball Possession': 'possessionPct',
  'Yellow Cards': 'yellowCards',
  'Red Cards': 'redCards',
  'Goalkeeper Saves': 'goalkeeperSaves',
  'Total passes': 'totalPasses',
  'Passes accurate': 'accuratePasses',
  'Passes %': 'passAccuracyPct',
  'expected_goals': 'expectedGoals',
};

export interface TeamStatsRow {
  teamProviderId: number;
  shotsTotal: number | null; shotsOnGoal: number | null; shotsOffGoal: number | null; shotsBlocked: number | null;
  shotsInsideBox: number | null; shotsOutsideBox: number | null; fouls: number | null; corners: number | null;
  offsides: number | null; possessionPct: number | null; yellowCards: number | null; redCards: number | null;
  goalkeeperSaves: number | null; totalPasses: number | null; accuratePasses: number | null;
  passAccuracyPct: number | null; expectedGoals: number | null;
  raw: Record<string, unknown>;
}

export function mapTeamStats(stats: AFTeamStats[]): TeamStatsRow[] {
  return (stats ?? []).map((s) => {
    const row: Record<string, unknown> = {};
    const out: Record<string, number | null> = {};
    for (const v of s.statistics ?? []) {
      row[v.type] = v.value;
      const field = STAT_FIELDS[v.type];
      if (field) {
        out[field] = v.type === 'Ball Possession' || v.type === 'Passes %' ? parsePossession(v.value) : parseNumeric(v.value);
      }
    }
    return {
      teamProviderId: s.team.id,
      shotsTotal: out.shotsTotal ?? null,
      shotsOnGoal: out.shotsOnGoal ?? null,
      shotsOffGoal: out.shotsOffGoal ?? null,
      shotsBlocked: out.shotsBlocked ?? null,
      shotsInsideBox: out.shotsInsideBox ?? null,
      shotsOutsideBox: out.shotsOutsideBox ?? null,
      fouls: out.fouls ?? null,
      corners: out.corners ?? null,
      offsides: out.offsides ?? null,
      possessionPct: out.possessionPct ?? null,
      yellowCards: out.yellowCards ?? null,
      redCards: out.redCards ?? null,
      goalkeeperSaves: out.goalkeeperSaves ?? null,
      totalPasses: out.totalPasses ?? null,
      accuratePasses: out.accuratePasses ?? null,
      passAccuracyPct: out.passAccuracyPct ?? null,
      expectedGoals: out.expectedGoals ?? null,
      raw: row,
    } as TeamStatsRow;
  });
}

export interface PlayerMatchStatsRow {
  playerProviderId: number;
  player: { providerId: number; name: string; photo?: string | null };
  teamProviderId: number;
  minutesPlayed: number | null;
  rating: number | null;
  position: string | null;
  isCaptain: boolean;
  isSubstitute: boolean;
  shotsTotal: number | null;
  shotsOnGoal: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  passesTotal: number | null;
  passesAccurate: number | null;
  passAccuracyPct: number | null;
  keyPasses: number | null;
  tackles: number | null;
  blocks: number | null;
  interceptions: number | null;
  duelsTotal: number | null;
  duelsWon: number | null;
  dribblesAttempts: number | null;
  dribblesSuccess: number | null;
  foulsDrawn: number | null;
  foulsCommitted: number | null;
  yellowCards: number | null;
  yellowredCards: number | null;
  redCards: number | null;
  penaltyWon: number | null;
  penaltyCommitted: number | null;
  penaltyScored: number | null;
  penaltyMissed: number | null;
  goalsConceded: number | null;
  cleanSheet: boolean | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  raw: AFPlayerStatistics;
}

export function mapPlayerMatchStats(rows: { team: { id: number }; players: { player: AFPlayer; statistics: AFPlayerStatistics[] }[] }[]): PlayerMatchStatsRow[] {
  const out: PlayerMatchStatsRow[] = [];
  for (const teamBlock of rows ?? []) {
    for (const entry of teamBlock.players ?? []) {
      for (const stat of entry.statistics ?? []) {
        out.push({
          playerProviderId: entry.player.id,
          player: { providerId: entry.player.id, name: entry.player.name, photo: entry.player.photo ?? null },
          teamProviderId: stat.team?.id ?? teamBlock.team?.id,
          minutesPlayed: parseIntOrNull(stat.games?.minutes),
          rating: stat.games?.rating ? parseNumeric(stat.games.rating) : null,
          position: stat.games?.position ?? null,
          isCaptain: Boolean(stat.games?.captain),
          isSubstitute: (stat.games?.lineups ?? 0) === 0 && (stat.substitutes?.bench ?? 0) > 0,
          shotsTotal: parseIntOrNull(stat.shots?.total),
          shotsOnGoal: parseIntOrNull(stat.shots?.on),
          goals: parseIntOrNull(stat.goals?.total),
          assists: parseIntOrNull(stat.goals?.assists),
          saves: parseIntOrNull(stat.goals?.saves),
          passesTotal: parseIntOrNull(stat.passes?.total),
          passesAccurate: parseIntOrNull(stat.passes?.total) !== null && stat.passes?.accuracy !== undefined
            ? Math.round((parseIntOrNull(stat.passes.total) ?? 0) * (parsePossession(stat.passes.accuracy) ?? 0) / 100) || null
            : null,
          passAccuracyPct: parsePossession(stat.passes?.accuracy),
          keyPasses: null, // provider does not expose key passes on this endpoint
          tackles: parseIntOrNull(stat.tackles?.total),
          blocks: parseIntOrNull(stat.tackles?.blocks),
          interceptions: parseIntOrNull(stat.tackles?.interceptions),
          duelsTotal: parseIntOrNull(stat.duels?.total),
          duelsWon: parseIntOrNull(stat.duels?.won),
          dribblesAttempts: parseIntOrNull(stat.dribbles?.attempts),
          dribblesSuccess: parseIntOrNull(stat.dribbles?.success),
          foulsDrawn: parseIntOrNull(stat.fouls?.drawn),
          foulsCommitted: parseIntOrNull(stat.fouls?.committed),
          yellowCards: parseIntOrNull(stat.cards?.yellow),
          yellowredCards: parseIntOrNull(stat.cards?.yellowred),
          redCards: parseIntOrNull(stat.cards?.red),
          penaltyWon: parseIntOrNull(stat.penalty?.won),
          penaltyCommitted: parseIntOrNull(stat.penalty?.commited),
          penaltyScored: parseIntOrNull(stat.penalty?.scored),
          penaltyMissed: parseIntOrNull(stat.penalty?.missed),
          goalsConceded: parseIntOrNull(stat.goals?.conceded),
          cleanSheet: stat.cleanSheets === null || stat.cleanSheets === undefined ? null : stat.cleanSheets > 0,
          expectedGoals: null,
          expectedAssists: null,
          raw: stat,
        });
      }
    }
  }
  return out;
}

export interface LineupRow {
  teamProviderId: number;
  formation: string | null;
  coach: { providerId: number | null; name: string | null } | null;
  players: LineupPlayerRow[];
}

export interface LineupPlayerRow {
  playerProviderId: number | null;
  playerName: string;
  shirtNumber: number | null;
  position: string | null;
  gridPosition: string | null;
  isStarting: boolean;
  isCaptain: boolean;
}

export function mapLineups(lineups: AFLineup[]): LineupRow[] {
  return (lineups ?? []).map((l) => ({
    teamProviderId: l.team.id,
    formation: l.formation ?? null,
    coach: l.coach ? { providerId: l.coach.id ?? null, name: l.coach.name ?? null } : null,
    players: [
      ...(l.startXI ?? []).map((p) => toLineupPlayer(p, true)),
      ...(l.substitutes ?? []).map((p) => toLineupPlayer(p, false)),
    ],
  }));
}

function toLineupPlayer(p: { id?: number | null; name: string; number?: number | null; pos?: string | null; grid?: string | null }, starting: boolean): LineupPlayerRow {
  // captain flag is embedded in grid as "row:col" plus name marker? provider marks captain via player.name? No — grid only.
  return {
    playerProviderId: p.id ?? null,
    playerName: p.name,
    shirtNumber: parseIntOrNull(p.number),
    position: p.pos ?? null,
    gridPosition: p.grid ?? null,
    isStarting: starting,
    isCaptain: false,
  };
}

export interface StandingRowData {
  teamProviderId: number;
  rank: number;
  points: number;
  played: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  goalDifference: number | null;
  form: string | null;
  description: string | null;
  groupName: string;
  home: { played: number; win: number; draw: number; lose: number; gf: number; ga: number } | null;
  away: { played: number; win: number; draw: number; lose: number; gf: number; ga: number } | null;
  raw: AFStandingRow;
}

export function mapStandings(rows: AFStandingRow[], groupFallback = 'default'): StandingRowData[] {
  return (rows ?? []).map((r) => ({
    teamProviderId: r.team.id,
    rank: r.rank,
    points: r.points,
    played: r.all?.played ?? null,
    wins: r.all?.win ?? null,
    draws: r.all?.draw ?? null,
    losses: r.all?.lose ?? null,
    goalsFor: r.all?.goals?.for ?? null,
    goalsAgainst: r.all?.goals?.against ?? null,
    goalDifference: r.goalsDiff ?? null,
    form: r.form ?? null,
    description: r.description ?? null,
    groupName: r.group ?? groupFallback,
    home: r.home
      ? { played: r.home.played, win: r.home.win, draw: r.home.draw, lose: r.home.lose, gf: r.home.goals.for, ga: r.home.goals.against }
      : null,
    away: r.away
      ? { played: r.away.played, win: r.away.win, draw: r.away.draw, lose: r.away.lose, gf: r.away.goals.for, ga: r.away.goals.against }
      : null,
    raw: r,
  }));
}

export interface InjuryRowData {
  player: { providerId: number; name: string };
  teamProviderId: number | null;
  fixtureProviderId: number | null;
  recordType: string;
  reason: string | null;
  competitionProviderId: number | null;
  seasonYear: number | null;
}

export function mapInjuries(injuries: AFInjury[]): InjuryRowData[] {
  return (injuries ?? [])
    .filter((i) => i.player)
    .map((i) => ({
      player: { providerId: i.player!.id, name: i.player!.name },
      teamProviderId: i.team?.id ?? null,
      fixtureProviderId: i.fixture?.id ?? null,
      recordType: /missing/i.test(i.type ?? '') ? 'missing' : /questionable/i.test(i.type ?? '') ? 'questionable' : (i.type ?? 'injury').toLowerCase(),
      reason: i.reason ?? null,
      competitionProviderId: i.league?.id ?? null,
      seasonYear: i.league?.season ?? null,
    }));
}

export interface TransferRowData {
  player: { providerId: number; name: string };
  providerTransferId: number | null;
  sourceTeamProviderId: number | null;
  destinationTeamProviderId: number | null;
  transferDate: string | null;
  transferType: string | null;
  isLoan: boolean;
  fee: string | null;
  updatedAt: string | null;
}

export function mapTransfers(t: AFTransfer): TransferRowData[] {
  return (t.transfers ?? []).map((tr) => ({
    player: { providerId: t.player.id, name: t.player.name },
    providerTransferId: tr.id ?? null,
    sourceTeamProviderId: tr.teams?.out?.id ?? null,
    destinationTeamProviderId: tr.teams?.in?.id ?? null,
    transferDate: tr.date ? tr.date.slice(0, 10) : null,
    transferType: tr.type ?? null,
    isLoan: /loan/i.test(tr.type ?? ''),
    fee: tr.type ?? null,
    updatedAt: t.update ?? null,
  }));
}

export interface OddsRowData {
  fixtureProviderId: number;
  providerUpdatedAt: string | null;
  bookmakers: {
    providerId: number;
    name: string;
    markets: { name: string; values: { label: string; selectionName: string; odd: number }[] }[];
  }[];
}

export function mapOdds(o: AFOddsResponse): OddsRowData | null {
  if (!o?.fixture?.id || !o.bookmakers?.length) return null;
  return {
    fixtureProviderId: o.fixture.id,
    providerUpdatedAt: o.update ?? null,
    bookmakers: o.bookmakers.map((b) => ({
      providerId: b.id,
      name: b.name,
      markets: (b.bets ?? []).map((bet) => ({
        name: bet.name,
        values: (bet.values ?? []).map((v) => ({
          label: v.value,
          selectionName: v.value,
          odd: parseNumeric(v.odd) ?? 0,
        })),
      })),
    })),
  };
}

export interface CoachRowData {
  providerId: number;
  name: string;
  firstname: string | null;
  lastname: string | null;
  age: number | null;
  birthDate: string | null;
  birthPlace: string | null;
  birthCountry: string | null;
  nationality: string | null;
  height: number | null;
  weight: number | null;
  photo: string | null;
  teamProviderId: number | null;
  career: { teamProviderId: number | null; teamName: string | null; start: string | null; end: string | null }[];
}

export function mapCoach(c: AFCoach): CoachRowData {
  return {
    providerId: c.id,
    name: c.name ?? [c.firstname, c.lastname].filter(Boolean).join(' '),
    firstname: c.firstname ?? null,
    lastname: c.lastname ?? null,
    age: parseIntOrNull(c.age),
    birthDate: c.birth?.date ?? null,
    birthPlace: c.birth?.place ?? null,
    birthCountry: c.birth?.country ?? null,
    nationality: c.nationality ?? null,
    height: parseHeightToInt(c.height),
    weight: parseWeightToInt(c.weight),
    photo: c.photo ?? null,
    teamProviderId: c.team?.id ?? null,
    career: (c.career ?? []).map((k) => ({
      teamProviderId: k.team?.id ?? null,
      teamName: k.team?.name ?? null,
      start: k.start ?? null,
      end: k.end ?? null,
    })),
  };
}

export interface PlayerRowData {
  providerId: number;
  name: string;
  firstname: string | null;
  lastname: string | null;
  nationality: string | null;
  birthDate: string | null;
  birthPlace: string | null;
  birthCountry: string | null;
  age: number | null;
  height: number | null;
  weight: number | null;
  injured: boolean | null;
  photo: string | null;
}

export function mapPlayer(p: AFPlayer): PlayerRowData {
  return {
    providerId: p.id,
    name: p.name,
    firstname: p.firstname ?? null,
    lastname: p.lastname ?? null,
    nationality: p.nationality ?? null,
    birthDate: p.birth?.date ?? null,
    birthPlace: p.birth?.place ?? null,
    birthCountry: p.birth?.country ?? null,
    age: parseIntOrNull(p.age),
    height: parseHeightToInt(p.height),
    weight: parseWeightToInt(p.weight),
    injured: p.injured ?? null,
    photo: p.photo ?? null,
  };
}

export { nameKey };
