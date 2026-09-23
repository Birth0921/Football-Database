-- 004: Fixtures and everything attached to them.

CREATE TABLE IF NOT EXISTS fixtures (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  provider_id           BIGINT NOT NULL,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id),
  competition_id        BIGINT NOT NULL REFERENCES competitions(id),
  season_year           INTEGER NOT NULL,
  round_id              BIGINT REFERENCES competition_rounds(id),
  round_name            TEXT,
  home_team_id          BIGINT NOT NULL REFERENCES teams(id),
  away_team_id          BIGINT NOT NULL REFERENCES teams(id),
  venue_id              BIGINT REFERENCES venues(id),
  referee_id            BIGINT REFERENCES referees(id),
  timezone              TEXT,
  kickoff_at            TIMESTAMPTZ,
  kickoff_date          DATE,
  status_short          TEXT,
  status_long           TEXT,
  status_code           INTEGER,
  status_elapsed        INTEGER,
  is_finished           BOOLEAN NOT NULL DEFAULT FALSE,
  has_extra_time        BOOLEAN,
  postponed             BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled             BOOLEAN NOT NULL DEFAULT FALSE,
  winner_team_id        BIGINT REFERENCES teams(id),
  home_score            INTEGER,
  away_score            INTEGER,
  ht_home_score         INTEGER,
  ht_away_score         INTEGER,
  ft_home_score         INTEGER,
  ft_away_score         INTEGER,
  et_home_score         INTEGER,
  et_away_score         INTEGER,
  pen_home_score        INTEGER,
  pen_away_score        INTEGER,
  provider_updated_at   TIMESTAMPTZ,
  data_hash             TEXT,
  finalized_at          TIMESTAMPTZ,
  raw                   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fixtures_teams_differ CHECK (home_team_id <> away_team_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fixtures_provider_pid ON fixtures (provider, provider_id);

CREATE TABLE IF NOT EXISTS fixture_periods (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id   BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,           -- 'first_half' | 'second_half' | custom
  started_at   TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  raw          JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_periods_unique ON fixture_periods (fixture_id, name);

CREATE TABLE IF NOT EXISTS fixture_scores (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id   BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  period       TEXT NOT NULL,           -- 'HT' | 'FT' | 'ET' | 'PEN'
  home_value   INTEGER,
  away_value   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_scores_unique ON fixture_scores (fixture_id, period);

CREATE TABLE IF NOT EXISTS fixture_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id       BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id          BIGINT REFERENCES teams(id),
  player_id        BIGINT REFERENCES players(id),
  assist_player_id BIGINT REFERENCES players(id),
  player_name      TEXT,
  assist_name      TEXT,
  event_type       TEXT NOT NULL,       -- 'Goal','Card','Subst',... (provider string preserved)
  event_detail     TEXT,
  comments         TEXT,
  minute           INTEGER,
  extra_minute     INTEGER,
  is_var           BOOLEAN NOT NULL DEFAULT FALSE,
  event_key        TEXT NOT NULL,       -- stable identity for idempotent replace
  sort_order       INTEGER NOT NULL DEFAULT 0,
  raw              JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_events_unique ON fixture_events (fixture_id, event_key);

CREATE TABLE IF NOT EXISTS fixture_team_statistics (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id         BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id            BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  shots_total        INTEGER,
  shots_on_goal      INTEGER,
  shots_off_goal     INTEGER,
  shots_blocked      INTEGER,
  shots_inside_box   INTEGER,
  shots_outside_box  INTEGER,
  fouls              INTEGER,
  corners            INTEGER,
  offsides           INTEGER,
  possession_pct     NUMERIC(5,2),
  yellow_cards       INTEGER,
  red_cards          INTEGER,
  goalkeeper_saves   INTEGER,
  total_passes       INTEGER,
  accurate_passes    INTEGER,
  pass_accuracy_pct  NUMERIC(5,2),
  expected_goals     NUMERIC(5,2),
  raw                JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_team_stats_unique ON fixture_team_statistics (fixture_id, team_id);

CREATE TABLE IF NOT EXISTS player_match_statistics (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id         BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  player_id          BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id            BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  minutes_played     INTEGER,
  rating             NUMERIC(4,2),
  position           TEXT,              -- position in this match (G/D/M/F or grid)
  is_captain         BOOLEAN NOT NULL DEFAULT FALSE,
  is_substitute      BOOLEAN NOT NULL DEFAULT FALSE,
  shots_total        INTEGER,
  shots_on_goal      INTEGER,
  goals              INTEGER,
  assists            INTEGER,
  saves              INTEGER,
  passes_total       INTEGER,
  passes_accurate    INTEGER,
  pass_accuracy_pct  NUMERIC(5,2),
  key_passes         INTEGER,
  tackles            INTEGER,
  blocks             INTEGER,
  interceptions      INTEGER,
  duels_total        INTEGER,
  duels_won          INTEGER,
  dribbles_attempts  INTEGER,
  dribbles_success   INTEGER,
  fouls_drawn        INTEGER,
  fouls_committed    INTEGER,
  yellow_cards       INTEGER,
  yellowred_cards    INTEGER,
  red_cards          INTEGER,
  penalty_won        INTEGER,
  penalty_committed  INTEGER,
  penalty_scored     INTEGER,
  penalty_missed     INTEGER,
  goals_conceded     INTEGER,
  clean_sheet        BOOLEAN,
  expected_goals     NUMERIC(5,2),
  expected_assists   NUMERIC(5,2),
  raw                JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_match_stats_unique ON player_match_statistics (fixture_id, player_id);
CREATE INDEX IF NOT EXISTS player_match_stats_team_idx ON player_match_statistics (team_id);

CREATE TABLE IF NOT EXISTS lineups (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id   BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  formation    TEXT,
  coach_id     BIGINT REFERENCES coaches(id),
  coach_name   TEXT,
  raw          JSONB,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lineups_unique ON lineups (fixture_id, team_id);

CREATE TABLE IF NOT EXISTS lineup_players (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lineup_id     BIGINT NOT NULL REFERENCES lineups(id) ON DELETE CASCADE,
  player_id     BIGINT REFERENCES players(id),
  player_name   TEXT NOT NULL,
  shirt_number  INTEGER,
  position      TEXT,                   -- G | D | M | F
  grid_position TEXT,                   -- e.g. "row:col"
  is_starting   BOOLEAN NOT NULL,
  is_captain    BOOLEAN NOT NULL DEFAULT FALSE,
  raw           JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS lineup_players_unique
  ON lineup_players (lineup_id, coalesce(player_id, -1), player_name, is_starting);

CREATE TABLE IF NOT EXISTS standings (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  group_name            TEXT NOT NULL DEFAULT 'default',
  provider_updated_at   TIMESTAMPTZ,
  raw                   JSONB,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS standings_unique ON standings (competition_season_id, group_name);

CREATE TABLE IF NOT EXISTS standing_rows (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  standings_id          BIGINT NOT NULL REFERENCES standings(id) ON DELETE CASCADE,
  team_id               BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rank                  INTEGER,
  points                INTEGER,
  played                INTEGER,
  wins                  INTEGER,
  draws                 INTEGER,
  losses                INTEGER,
  goals_for             INTEGER,
  goals_against         INTEGER,
  goal_difference       INTEGER,
  form                  TEXT,
  description           TEXT,
  home_played           INTEGER,
  home_wins             INTEGER,
  home_draws            INTEGER,
  home_losses           INTEGER,
  home_goals_for        INTEGER,
  home_goals_against    INTEGER,
  away_played           INTEGER,
  away_wins             INTEGER,
  away_draws            INTEGER,
  away_losses           INTEGER,
  away_goals_for        INTEGER,
  away_goals_against    INTEGER,
  raw                   JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS standing_rows_unique ON standing_rows (standings_id, team_id);
