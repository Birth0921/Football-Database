/** Raw API-Football v3 response shapes (subset we consume). */

export interface AFCountry {
  id?: number;
  name: string;
  code?: string | null;
  flag?: string | null;
}

export interface AFVenue {
  id?: number | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  capacity?: number | null;
  surface?: string | null;
  image?: string | null;
}

export interface AFSeason {
  year: number;
  start: string;
  end: string;
  current: boolean;
  coverage: AFCoverage;
}

export interface AFCoverage {
  events?: boolean;
  lineups?: boolean;
  statistics_fixtures?: boolean;
  statistics_players?: boolean;
  standings?: boolean;
  players?: boolean;
  top_scorers?: boolean;
  top_assists?: boolean;
  top_cards?: boolean;
  injuries?: boolean;
  sidelined?: boolean;
  predictions?: boolean;
  odds?: boolean;
}

export interface AFLeague {
  id: number;
  name: string;
  type: string; // 'league' | 'cup'
  logo?: string;
  country?: AFCountry;
  seasons?: AFSeason[];
}

export interface AFTeam {
  id: number;
  name: string;
  code?: string | null;
  country?: string | null;
  founded?: number | null;
  national?: boolean;
  logo?: string | null;
  venue?: AFVenue | null;
}

export interface AFPlayer {
  id: number;
  name: string;
  firstname?: string;
  lastname?: string;
  nationality?: string;
  birth?: { date?: string | null; place?: string | null; country?: string | null };
  age?: number | null;
  height?: string | null;
  weight?: string | null;
  injured?: boolean;
  photo?: string | null;
}

export interface AFPlayerStatistics {
  team?: AFTeam;
  league?: { id?: number; name?: string; season?: number; logo?: string; country?: string };
  games?: { appearences?: number; lineups?: number; minutes?: number; number?: number; position?: string; rating?: string; captain?: boolean };
  substitutes?: { in?: number; out?: number; bench?: number };
  shots?: { total?: number | null; on?: number | null };
  goals?: { total?: number | null; conceded?: number | null; assists?: number | null; saves?: number | null };
  passes?: { total?: number | null; key?: number | null; accuracy?: string | number | null };
  tackles?: { total?: number | null; blocks?: number | null; interceptions?: number | null };
  duels?: { total?: number | null; won?: number | null };
  dribbles?: { attempts?: number | null; success?: number | null; past?: number | null };
  fouls?: { drawn?: number | null; committed?: number | null };
  cards?: { yellow?: number | null; yellowred?: number | null; red?: number | null };
  penalty?: { won?: number | null; commited?: number | null; scored?: number | null; missed?: number | null; saved?: number | null };
  cleanSheets?: number | null;
}

export interface AFFixture {
  id: number;
  referee?: string | null;
  timezone?: string;
  date: string;
  timestamp?: number;
  venue?: { id?: number | null; name?: string | null; city?: string | null } | null;
  status?: { long?: string; short?: string; elapsed?: number | null } | { long?: string; short?: string; elapsed?: number | null };
}

export interface AFFixtureResponse {
  fixture: AFFixture;
  league: { id: number; name: string; country?: string; logo?: string; flag?: string; season: number; round?: string };
  teams: { home: AFTeam; away: AFTeam };
  goals: { home: number | null; away: number | null };
  score: {
    halftime?: { home: number | null; away: number | null };
    fulltime?: { home: number | null; away: number | null };
    extratime?: { home: number | null; away: number | null };
    penalty?: { home: number | null; away: number | null };
  };
}

export interface AFEvent {
  time?: { elapsed?: number | null; extra?: number | null };
  team?: { id?: number | null; name?: string };
  player?: { id?: number | null; name?: string } | null;
  assist?: { id?: number | null; name?: string } | null;
  type: string;
  detail?: string | null;
  comments?: string | null;
}

export interface AFStatValue { type: string; value: string | number | null }
export interface AFTeamStats { team: AFTeam; statistics: AFStatValue[] }
export interface AFLineupPlayer { id?: number | null; name: string; number?: number | null; pos?: string | null; grid?: string | null }
export interface AFLineup {
  team: AFTeam;
  coach?: { id?: number | null; name?: string } | null;
  formation?: string | null;
  startXI?: AFLineupPlayer[];
  substitutes?: AFLineupPlayer[];
}

export interface AFStandingRow {
  rank: number;
  team: AFTeam;
  points: number;
  goalsDiff?: number;
  group?: string | null;
  form?: string | null;
  status?: string | null;
  description?: string | null;
  all?: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
  home?: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
  away?: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
  update?: string;
}

export interface AFInjury {
  fixture?: { id?: number } | null;
  league?: { id?: number; name?: string; season?: number; logo?: string } | null;
  team?: AFTeam | null;
  player?: AFPlayer | null;
  type?: string;   // e.g. "Missing Fixture" | "Questionable"
  reason?: string;
}

export interface AFTransfer {
  player: AFPlayer;
  update?: string;
  transfers?: {
    id?: number | null;
    date?: string;
    type?: string;
    teams?: { in?: AFTeam | null; out?: AFTeam | null };
  }[];
}

export interface AFOddsValue { value: string; odd: string | number }
export interface AFOddsBet { id: number; name: string; values: AFOddsValue[] }
export interface AFOddsBookmaker { id: number; name: string; bets: AFOddsBet[] }
export interface AFOddsResponse { fixture?: { id: number }; league?: { id: number; season: number }; update?: string; bookmakers?: AFOddsBookmaker[] }

export interface AFCoach {
  id: number;
  name?: string;
  firstname?: string;
  lastname?: string;
  age?: number | null;
  birth?: { date?: string | null; place?: string | null; country?: string | null };
  nationality?: string;
  height?: string | null;
  weight?: string | null;
  team?: AFTeam | null;
  career?: { team?: AFTeam | null; start?: string | null; end?: string | null }[];
  photo?: string | null;
}
