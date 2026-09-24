# Database

PostgreSQL 14+ (verified on 18.4). All timestamps are `TIMESTAMPTZ` (UTC).
Unavailable values are stored as `NULL` — never coerced to zero. Unmodeled or
provider-specific data survives in `JSONB` (`raw`, `extra_stats`).
Migrations live in `migrations/*.sql` and are tracked in `schema_migrations`.

## Entity relationships (simplified)

```
countries ─┬─< competitions ──< competition_seasons >── seasons
           │                        │  └─< competition_season_coverage
           └─< venues ──< teams ────┼──< team_seasons
                                    │
 players ──< player_team_history    │
    │                               │
    ├─< player_match_statistics ──< fixtures >── fixture_periods
    └─< player_season_statistics     │      └──< fixture_scores
                                     ├──< fixture_events
 referees ──< referee_match_statistics│  ├──< fixture_team_statistics
    ├─< referee_season_statistics     │  ├──< lineups ──< lineup_players
    └─< referee_competition_statistics│  └──< player_match_statistics
                                     │
 team_competition_season_stats ──────┘
 league_season_statistics ─── competition_seasons
 h2h_stats ─── teams (pairs)
 sidelined_records, transfers ─── players/teams
 bookmakers ──< odds ──< odds_values ── fixtures
 prediction_features ── fixtures

 raw_provider_payloads, provider_requests, provider_quota   (provider layer)
 sync_jobs ──< sync_tasks, sync_state                       (sync engine)
 api_clients ──< api_keys ──< api_usage, api_audit_log      (our API keys)
 data_quality_results                                        (quality checks)
```

## Key tables (38)

**Reference:** `countries`, `competitions`, `seasons`, `competition_seasons`,
`competition_season_coverage`, `venues`, `competition_rounds`

**Teams/players/referees:** `teams`, `team_seasons`, `team_coach_history`,
`players`, `player_team_history`, `referees`, `referee_match_statistics`,
`referee_season_statistics`, `referee_competition_statistics`

**Fixtures:** `fixtures`, `fixture_periods`, `fixture_scores`,
`fixture_events`, `fixture_team_statistics`, `player_match_statistics`,
`lineups`, `lineup_players`, `standings`, `standing_rows`

**Other football data:** `sidelined_records`, `transfers`, `bookmakers`,
`odds`, `odds_values`, `player_season_statistics`

**Derived:** `team_competition_season_stats`, `league_season_statistics`,
`h2h_stats`, `prediction_features`

**Provider/sync/keys:** `raw_provider_payloads`, `provider_requests`,
`provider_quota`, `sync_jobs`, `sync_tasks`, `sync_state`, `api_clients`,
`api_keys`, `api_usage`, `api_audit_log`, `data_quality_results`

## Constraints & indexes (spec §47)

- `fixtures`: UNIQUE `(provider, provider_fixture_id)`; CHECK home ≠ away;
  indexes on competition+season+date, team+date, status, kickoff time
- `fixture_events`: UNIQUE event identity; indexes by fixture/team/player
- `fixture_team_statistics`: UNIQUE `(fixture_id, team_id)`
- `player_match_statistics`: UNIQUE `(fixture_id, player_id)`
- provider IDs: UNIQUE `(provider, provider_id)` on teams/players/referees/
  venues/competitions/countries/sidelined — duplicate imports cannot duplicate
- standings: UNIQUE `(standings_id, team_id)`
- `sync_tasks`: UNIQUE `task_key`; dispatch index `(status, priority,
  scheduled_for)`
- `api_keys`: UNIQUE `key_prefix`; hash index; usage UNIQUE per key/day/endpoint
- `raw_provider_payloads`/`provider_requests`: lookup + time indexes

## Design decisions

1. **Internal BIGSERIAL IDs** everywhere; provider IDs live in `provider_id`
   columns — no leakage of external IDs as primary keys.
2. **Score phases** (`fixture_scores` + `home_score_*` columns) keep HT/FT/ET/PEN
   distinct; extra time/penalties never overwrite full-time scores.
3. **Coverage flags** prevent pointless provider calls (e.g. cup competitions
   without standings) and record discovered limitations per competition/season.
4. **Derived stats are local** (referee/team/player/league/H2H/prediction) so
   recalculation never consumes provider quota.
5. **Historical completed fixtures are immutable** once `finalized = TRUE`:
  details are not re-fetched unless data is missing (post-match pipeline
   reuses stored rows).
