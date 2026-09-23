-- 008: Additional performance indexes (spec section 47).

CREATE INDEX IF NOT EXISTS fixtures_comp_season_date_idx ON fixtures (competition_id, season_year, kickoff_at);
CREATE INDEX IF NOT EXISTS fixtures_cs_date_idx ON fixtures (competition_season_id, kickoff_at);
CREATE INDEX IF NOT EXISTS fixtures_home_team_date_idx ON fixtures (home_team_id, kickoff_at DESC);
CREATE INDEX IF NOT EXISTS fixtures_away_team_date_idx ON fixtures (away_team_id, kickoff_at DESC);
CREATE INDEX IF NOT EXISTS fixtures_status_idx ON fixtures (status_short);
CREATE INDEX IF NOT EXISTS fixtures_finished_idx ON fixtures (is_finished, kickoff_at DESC);
CREATE INDEX IF NOT EXISTS fixtures_kickoff_idx ON fixtures (kickoff_at);
CREATE INDEX IF NOT EXISTS fixtures_referee_idx ON fixtures (referee_id) WHERE referee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fixtures_venue_idx ON fixtures (venue_id) WHERE venue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fixture_events_fixture_idx ON fixture_events (fixture_id, minute);
CREATE INDEX IF NOT EXISTS fixture_events_team_idx ON fixture_events (team_id);
CREATE INDEX IF NOT EXISTS fixture_events_player_idx ON fixture_events (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fixture_events_type_idx ON fixture_events (fixture_id, event_type);

CREATE INDEX IF NOT EXISTS fixture_team_stats_team_idx ON fixture_team_statistics (team_id, fixture_id DESC);
CREATE INDEX IF NOT EXISTS player_match_stats_player_idx ON player_match_statistics (player_id, fixture_id DESC);
CREATE INDEX IF NOT EXISTS player_match_stats_fixture_idx ON player_match_statistics (fixture_id);

CREATE INDEX IF NOT EXISTS standings_comp_season_idx ON standings (competition_season_id);
CREATE INDEX IF NOT EXISTS standing_rows_team_idx ON standing_rows (team_id);

CREATE INDEX IF NOT EXISTS sidelined_records_cs_idx ON sidelined_records (competition_season_id) WHERE competition_season_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transfers_date_idx ON transfers (transfer_date DESC);

CREATE INDEX IF NOT EXISTS team_statistics_team_idx ON team_statistics (team_id);
CREATE INDEX IF NOT EXISTS player_season_stats_player_idx ON player_season_statistics (player_id, competition_season_id DESC);
CREATE INDEX IF NOT EXISTS referee_season_stats_referee_idx ON referee_season_statistics (referee_id);

-- Provider quota tracking view helpers
CREATE INDEX IF NOT EXISTS provider_requests_success_idx ON provider_requests (success, started_at DESC);
