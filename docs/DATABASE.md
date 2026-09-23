# Database

PostgreSQL, UTC (`TIMESTAMPTZ`) everywhere, `NULL` = unavailable (never fabricated zeros), JSONB for provider-specific extras. Internal `BIGINT IDENTITY` primary keys; upstream ids stored as `(provider, provider_id)` pairs with unique constraints.

Migrations live in `migrations/*.sql`, applied in filename order by `npm run db:migrate` (tracked in `schema_migrations`).

## Entity map

```
countries ──┬── competitions ── competition_seasons ──┬── competition_season_coverage
            ├── venues                                 ├── competition_rounds
            ├── teams ── team_seasons                  ├── fixtures ──┬── fixture_events
            ├── players ── player_team_history         │              ├── fixture_team_statistics
            ├── coaches ── team_coach_history          │              ├── player_match_statistics
            └── referees                               │              ├── lineups ── lineup_players
                                                       │              ├── fixture_periods / fixture_scores
standings ── standing_rows                             │              └── odds ── odds_values (bookmakers)
sidelined_records · transfers                          └── (scope)

Analytics (derived): league_statistics · team_statistics · player_season_statistics
                     referee_match_statistics · referee_season_statistics · referee_competition_statistics
                     prediction_features

Platform: api_clients · api_keys · api_usage
Sync:     sync_jobs · sync_tasks · sync_state · raw_provider_payloads · provider_requests
```

## Key tables

### Reference data
- **countries** — provider id and/or bare-name rows (merged automatically)
- **venues** — stadium info, capacity, surface
- **competitions** — provider league/cup id, type, country, logo
- **seasons** — season years (unique)
- **competition_seasons** — the (competition × season) scope entity, provider id, dates, `is_current`
- **competition_season_coverage** — boolean coverage flags per season: `events, lineups, fixture_statistics, player_statistics, standings, players, top_scorers, top_assists, top_cards, injuries, sidelined, predictions, odds`
- **competition_rounds** — round names per season ("Regular Season - 1", …)

### People & teams
- **teams / team_seasons** — club info + which seasons it played (unique per pair)
- **players** — profile; **player_team_history** — a player may have multiple teams *per season* (loans, transfers, national teams)
- **coaches / team_coach_history** — manager careers
- **referees** — provider gives no referee ids; identity is normalized `name_key` (name+country from fixture referee strings)

### Fixtures & match data
- **fixtures** — unique `(provider, provider_id)`; teams, venue, referee, kickoff (`TIMESTAMPTZ` + date), status short/long/elapsed, flags (`is_finished`, `postponed`, `cancelled`, `has_extra_time`), winner, HT/FT/ET/PEN scores, `data_hash` for change detection, `finalized_at` (post-match pipeline marker)
- **fixture_events** — goals/cards/subs/VAR/missed penalties with minute+extra minute; unknown provider types preserved in `raw`; idempotent via `event_key`
- **fixture_team_statistics** — shots (total/on/off/blocked/inside/outside), possession, passes, fouls, corners, cards, GK saves, xG (when available), plus `raw` JSONB
- **player_match_statistics** — full per-match line: minutes, rating, captain/sub, shots, passes, duels, dribbles, fouls, cards, penalties, GK saves/conceded/clean sheet
- **lineups / lineup_players** — formation, coach, starting XI + substitutes with shirt numbers, positions, grid
- **standings / standing_rows** — rank, points, W/D/L, GF/GA, form, description + home/away splits
- **sidelined_records** — injuries/absences from `/injuries` (fixture-scoped) with type + reason; dates only when the provider provides them
- **transfers** — player moves with fee/type/loan detection
- **bookmakers / odds / odds_values** — betting data, strictly separated from football statistics

### Analytics (all computed locally, quota-free)
- **league_statistics** — per competition+season: matches, goals, home/away splits, BTTS %, clean-sheet %, cards, fouls, penalties, corners, shots, possession avg, xG avg
- **team_statistics** — per team+season: full W/D/L home/away splits, averages, rates, `form_last5/10/20`, home/away form, streaks JSONB
- **player_season_statistics** — per player+season with a row per team **plus an aggregate row** (`team_id NULL`) for multi-team seasons
- **referee_match_statistics** — per-match referee card/foul/penalty/corners profile (from events + team stats)
- **referee_season_statistics** — aggregates + `last5/last10/last20` match JSON windows
- **referee_competition_statistics** — career-level per competition
- **prediction_features** — the assembled JSON feature set per fixture (served by `/predictions/features/:fixtureId`)

### Platform & sync
- **api_clients / api_keys / api_usage** — our key system; keys store only `key_prefix` + HMAC-`key_hash`; usage is per key/day/endpoint with success/failure/rate-limited counters
- **sync_jobs / sync_tasks / sync_state** — durable queue; tasks have priority, attempts, backoff `scheduled_at`, idempotent `unique_key`; state markers power the scheduler
- **raw_provider_payloads** — every provider response archive (dedup by params hash) for future reprocessing
- **provider_requests** — full request log with duration, status, quota-remaining snapshots, sync-task linkage (never logs the key)

## Important indexes (spec §47)

Fixtures by (competition, season, date), team+date, status, kickoff; events by fixture/team; stats by fixture/team; player stats by player and by fixture; referee stats by referee; standings by competition+season; sync tasks by (status, priority, scheduled_at) partial index; provider requests by date; raw payloads by provider/entity/fetched time; API keys by prefix/hash; API usage by client/date. Uniqueness constraints prevent duplicate fixtures, events, standings rows, injuries, transfers.
