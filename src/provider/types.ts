/**
 * API-Football (api-sports.io v3) response shapes — partial, permissive.
 * Unmodeled fields always survive in `raw` JSONB columns.
 */

export interface AfTeam {
  id: number | null;
  name: string | null;
  code?: string | null;
  country?: string | null;
  founded?: number | null;
  national?: boolean | null;
  logo?: string | null;
}

export interface AfVenue {
  id: number | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  capacity?: number | null;
  surface?: string | null;
  image?: string | null;
}

export interface AfCountry {
  name?: string | null;
  code?: string | null;
  flag?: string | null;
}

export interface AfLeague {
  id: number;
  name: string;
  country?: string | null;
  logo?: string | null;
  flag?: string | null;
  season?: number;
  round?: string;
  type?: string | null;
  code?: string | null;
  is_national?: boolean | null;
}

export interface AfFixture {
  id: number;
  referee?: string | null;
  timezone?: string | null;
  date?: string | null;
  timestamp?: number | null;
  venue?: AfVenue | null;
  status?: {
    long?: string | null;
    short?: string | null;
    elapsed?: number | null;
    extra?: number | null;
  } | null;
  league?: AfLeague | null;
  teams?: { home: AfTeam | null; away: AfTeam | null } | null;
  goals?: { home: number | null; away: number | null } | null;
  score?: {
    halftime?: { home: number | null; away: number | null } | null;
    fulltime?: { home: number | null; away: number | null } | null;
    extratime?: { home: number | null; away: number | null } | null;
    penalty?: { home: number | null; away: number | null } | null;
  } | null;
  lineups?: AfLineup[];
  statistics?: AfTeamStatEntry[];
  players?: AfPlayerStatEntry[];
  events?: AfEvent[];
  periods?: { first: number | null; second: number | null } | null;
}

export interface AfEvent {
  time?: { elapsed?: number | null; extra?: number | null } | null;
  team?: AfTeam | null;
  player?: { id: number | null; name?: string | null } | null;
  assist?: { id: number | null; name?: string | null } | null;
  type?: string | null;
  detail?: string | null;
  comments?: string | null;
}

export interface AfTeamStatEntry {
  team?: AfTeam | null;
  statistics?: AfTeamStat[] | null;
}

export interface AfTeamStat {
  type?: string | null;
  value?: number | string | null;
}

export interface AfPlayerInfo {
  id: number | null;
  name?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  age?: number | null;
  birth?: { date?: string | null; place?: string | null; country?: string | null } | null;
  nationality?: string | null;
  height?: string | null;
  weight?: string | null;
  injured?: boolean | null;
  photo?: string | null;
}

export interface AfPlayerStatEntry {
  team?: AfTeam | null;
  players?: {
    player?: AfPlayerInfo | null;
    statistics?: AfPlayerStatLine[] | null;
  }[] | null;
}

export interface AfPlayerStatLine {
  team?: AfTeam | null;
  games?: {
    minutes?: number | null;
    number?: number | null;
    position?: string | null;
    rating?: string | number | null;
    captain?: boolean | null;
    substitute?: boolean | null;
  } | null;
  shots?: { total?: number | null; on?: number | null } | null;
  goals?: {
    total?: number | null;
    conceded?: number | null;
    assists?: number | null;
    saves?: number | null;
  } | null;
  passes?: { total?: number | null; key?: number | null; accuracy?: number | string | null } | null;
  tackles?: { total?: number | null; blocks?: number | null; interceptions?: number | null } | null;
  dribbles?: { attempts?: number | null; success?: number | null; past?: number | null } | null;
  duels?: { total?: number | null; won?: number | null } | null;
  fouls?: { drawn?: number | null; committed?: number | null } | null;
  cards?: { yellow?: number | null; yellowred?: number | null; red?: number | null } | null;
  penalty?: {
    won?: number | null;
    committed?: number | null;
    scored?: number | null;
    missed?: number | null;
    saved?: number | null;
  } | null;
}

export interface AfLineup {
  team?: AfTeam | null;
  coach?: { id: number | null; name?: string | null; photo?: string | null } | null;
  formation?: string | null;
  startXI?: { player?: AfLineupPlayer | null }[] | null;
  substitutes?: { player?: AfLineupPlayer | null }[] | null;
}

export interface AfLineupPlayer {
  id: number | null;
  name?: string | null;
  number?: number | null;
  pos?: string | null;
  grid?: string | null;
}

export interface AfStandingRow {
  rank?: number | null;
  team?: AfTeam | null;
  points?: number | null;
  goalsDiff?: number | null;
  group?: string | null;
  form?: string | null;
  status?: string | null;
  description?: string | null;
  all?: AfStandingSplit | null;
  home?: AfStandingSplit | null;
  away?: AfStandingSplit | null;
  update?: string | null;
}

export interface AfStandingSplit {
  played?: number | null;
  win?: number | null;
  draw?: number | null;
  lose?: number | null;
  goals?: { for: number | null; against: number | null } | null;
}

export interface AfStandingsEntry {
  league?: {
    id?: number | null;
    name?: string | null;
    country?: string | null;
    logo?: string | null;
    flag?: string | null;
    season?: number | null;
    standings?: AfStandingRow[][] | null;
  } | null;
}

export interface AfSquadEntry {
  team?: AfTeam | null;
  players?: {
    id: number | null;
    name?: string | null;
    age?: number | null;
    number?: number | null;
    position?: string | null;
    photo?: string | null;
  }[] | null;
}

export interface AfInjury {
  player?: AfPlayerInfo | null;
  team?: AfTeam | null;
  fixture?: { id?: number | null; league?: number | null; season?: number | null } | null;
  league?: { id?: number | null; season?: number | null } | null;
  type?: { reason?: string | null; start?: string | null; end?: string | null } | null;
}

export interface AfTransfer {
  player?: { id: number | null; name?: string | null } | null;
  update?: string | null;
  type?: string | null;
  teams?: { in?: AfTeam | null; out?: AfTeam | null } | null;
  date?: string | null;
}

export interface AfOddsEntry {
  league?: { id?: number | null; name?: string | null; season?: number | null; country?: string | null; logo?: string | null; flag?: string | null } | null;
  fixture?: { id?: number | null; date?: string | null } | null;
  update?: string | null;
  bookmakers?: {
    id?: number | null;
    name?: string | null;
    bets?: {
      id?: number | null;
      name?: string | null;
      values?: { value?: string | null; odd?: string | null }[] | null;
    }[] | null;
  }[] | null;
}

export interface AfStatus {
  account?: { plan?: string | null; requests?: number | null; 'day-sessions'?: number | null; 'month-sessions'?: number | null } | null;
  subscription?: { started?: string | null; end?: string | null } | null;
}
