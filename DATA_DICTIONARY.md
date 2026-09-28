# Data Dictionary

Conventions: `BIGSERIAL` internal ids; `provider`/`provider_id` = external ids
(default provider `api-football`); `raw JSONB` preserves unmodeled provider
fields; timestamps `TIMESTAMPTZ`; unavailable data is `NULL` (never 0).

## Reference

| Table | Notable columns |
|-------|-----------------|
| `countries` | name, code, flag_url |
| `competitions` | name, code, type (League/Cup), country_id, is_national |
| `seasons` | year (start year), display_name (`2025/26`), start_date, end_date, is_current |
| `competition_seasons` | competition_id, season_id, is_current, import_scope |
| `competition_season_coverage` | per-competition-season boolean support flags: events, lineups, fixture_statistics, player_statistics, standings, players, top_scorers, top_assists, top_cards, injuries, sidelined, predictions, odds, referees |
| `venues` | name, city, address, capacity, surface |
| `competition_rounds` | competition_season_id, name, round_number |

## Teams / players / referees

| Table | Notable columns |
|-------|-----------------|
| `teams` | name, short_name, code, country_id, founded, logo_url, venue_id |
| `team_seasons` | team_id + competition_id + season_id membership |
| `team_coach_history` | coach_name, nationality, start/end dates |
| `players` | name, date_of_birth, age, nationality, height_cm, weight_kg, position, preferred_foot, current_team_id |
| `player_team_history` | player_id, team_id, season_id, start/end dates, number, position, transfer_type (multi-team seasons supported) |
| `referees` | name, first/last name, nationality |
| `referee_match_statistics` | per fixture: yellow_home/away, second_yellow, red_cards, fouls, penalties (derived locally) |
| `referee_season_statistics` | matches, home_wins/draws/away_wins, yellow/red/total cards + per-match, fouls/penalties + per-match, home/away cards + per-match, last_5/10/20 JSONB |
| `referee_competition_statistics` | per referee×competition aggregates |

## Fixtures

| Table | Notable columns |
|-------|-----------------|
| `fixtures` | provider_fixture_id (UNIQUE with provider), competition/season/round, home/away team, venue, referee, timezone, kickoff_utc, status_short (`NS/1H/HT/2H/ET/BT/P/FT/AET/PEN/PST/CANC/ABD/SUSP/INT`), status_elapsed/extra, postponed, home/away_score + _ht + _et + _pen, finalized(+at), data_hash, last_synced_at |
| `fixture_periods` | FIRST/SECOND/EXTRA/PENALTIES markers |
| `fixture_scores` | score_type (1ST_HALF/2ND_HALF/FULL_TIME/EXTRA_TIME/PENALTIES) + home/away |
| `fixture_events` | event_type (Goal/Card/subst/Var/…), event_detail (Normal Goal, Penalty, Own Goal, Missed Penalty, Yellow/Red/Second Yellow…), elapsed, extra, time_label, team, player, assist_player, comments; unknown types preserved |
| `fixture_team_statistics` | shots_total/on/off/blocked/inside/outside box, possession_pct, passes_total/accurate/pass_accuracy_pct, corners, offsides, fouls, yellow_cards, second_yellow_cards, red_cards, goalkeeper_saves, crosses(+accurate), tackles, interceptions, clearances, blocks, duels(+won), aerials(+won), dribbles(+success), expected_goals, extra_stats JSONB |
| `player_match_statistics` | minutes, rating, position, captain, substitute, goals/assists/conceded/saves, shots(+on), key_passes, passes(+accurate), tackles, blocks, interceptions, clearances, duels(+won), dribbles(+success), fouls_committed/drawn, offsides, yellow/second_yellow/red, penalties_won/committed/goal/missed/saved, clean_sheet, expected_goals/assists |
| `lineups` / `lineup_players` | formation, coach, grid_position, number, starting/substitute, captain, minutes |

## Standings / availability / transfers / odds

| Table | Notable columns |
|-------|-----------------|
| `standings` | competition_season_id, group_name (JSONB provider dump) |
| `standing_rows` | rank, points, played, wins, draws, losses, goals_for/against, goal_diff, form, description, all/home/away stats JSONB |
| `sidelined_records` | type (injury/suspension/…), reason, start_date, end_date (NULL when unknown — never invented), provider_endpoint |
| `transfers` | player, from/to teams, transfer_date, transfer_type (transfer/loan/loan_end/free…), fee_note |
| `bookmakers` / `odds` / `odds_values` | market/value/odds + timestamps (kept separate from football stats) |

## Derived analytics

| Table | Notable columns |
|-------|-----------------|
| `player_season_statistics` | appearances, starts (lineups), minutes, goals/assists, shots(+on), key_passes, passes(+accurate), tackles/interceptions/blocks/clearances, duels(+won), dribbles(+success), fouls(+drawn), offsides, penalties*, clean_sheets, expected_goals/assists, is_local_derived |
| `team_competition_season_stats` | matches, W/D/L + home/away splits, goals_for/against/diff, avg goals scored/conceded, clean_sheets, failed_to_score, btts, cards, fouls, corners, shots(+on), possession_avg, expected_goals, last_5/10/20, home/away form, streaks |
| `league_season_statistics` | matches/completed, goals(+per-match), home/away goals, home_wins/draws/away_wins, btts/clean_sheet/failed_to_score %, yellow/second_yellow/red + per-match, total cards + per-match, fouls/penalties/corners/shots(+on) + per-match, possession_avg, expected_goals |
| `h2h_stats` | team pair + window_size: fixtures_count, wins/draws, goals, btts, clean sheets, cards, corners, last_meetings JSONB |
| `prediction_features` | per fixture: home/away form (overall + home/away split) with PPG, goals/conceded/shots/sot/possession/corners/cards/fouls averages, clean-sheet/FTS/BTTS rates, league averages, referee features, full team/league stat dumps, player_availability, h2h, lineups_available, data_freshness |

## Provider / sync / API-key system

| Table | Notable columns |
|-------|-----------------|
| `raw_provider_payloads` | endpoint, request_param_hash (secret-free), request_params, entity ids, response_json, http_status, response_hash, fetched_at |
| `provider_requests` | endpoint, timing, http_status, success, cache_hit, quota remainders, sync_task, error |
| `provider_quota` | day, daily/minute limits + used + remaining, state (NORMAL/CAUTION/CRITICAL) |
| `sync_jobs` / `sync_tasks` / `sync_state` | job_key/task_key idempotency, task_type, params, priority, status, attempts/max_attempts, scheduled_for, backoff, result_summary, last_error |
| `api_clients` | name, client_type, active, rate_limit_per_minute/day |
| `api_keys` | key_prefix (UNIQUE), key_hash (SHA-256 — raw never stored), scopes TEXT[], expires_at, revoked_at(+reason), rotated_from, grace_until, last_used_at |
| `api_usage` | per key/client/day/endpoint counters: requests, successful, failed, rate_limited |
| `api_audit_log` | key/client lifecycle events |
| `data_quality_results` | check_key, status (PASS/WARN/FAIL), message, details |
