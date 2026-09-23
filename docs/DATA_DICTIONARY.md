# Data Dictionary

Conventions: all timestamps UTC (`TIMESTAMPTZ`); `NULL` means *unavailable at the provider* (never 0); provider-specific extras live in `raw` JSONB columns; upstream identity is `(provider, provider_id)`.

## Fixtures

| Field | Meaning |
|---|---|
| `status_short` | Provider status code: `NS` scheduled, `1H/2H/HT` live, `ET/PEN` extra time/penalties, `FT/AET/PEN` finished, `PST` postponed, `CANC/SUSP/ABD/INT` stopped, `AWD/WO` awarded |
| `is_finished` | Derived: FT/AET/PEN |
| `home_score / away_score` | Final score (incl. ET/pen shoot-out result where applicable) |
| `ht_/ft_/et_/pen_home/away_score` | Period scores; NULL when the period never happened |
| `winner_team_id` | NULL for draws, cancelled and not-started |
| `data_hash` | Hash of (status, scores, elapsed) — change detection for sync |
| `finalized_at` | Set once the post-match pipeline has pulled final details |

## Fixture events

`event_type` / `event_detail` preserve provider vocabulary, e.g. `Goal` + `Normal Goal|Own Goal|Penalty|Missed Penalty`, `Card` + `Yellow Card|Second Yellow card|Red card`, `Subst`, `Var`. Unknown future types are stored verbatim (never dropped). `event_key` is a stable hash used for idempotent re-import.

## Team / match statistics

Direct mapping of API-Football `/fixtures/statistics` metrics: shots (total/on goal/off/blocked/inside/outside), ball possession (%), passes (total/accurate/%), fouls, corners, offsides, cards, goalkeeper saves, `expected_goals` when the provider exposes it. Every metric is nullable — absence means the provider didn't supply it for that match.

## Player statistics

Per match (`player_match_statistics`) and per season (`player_season_statistics`): appearances/starts/minutes, goals/assists, shots, passes, key passes (NULL — not exposed by the fixture-players endpoint), tackles/blocks/interceptions, duels, dribbles, fouls drawn/committed, cards (yellow / second-yellow / red), penalties won/committed/scored/missed, goalkeeper saves, goals conceded, clean sheets, xG/xA where available. Season rows exist per team **and** an aggregate row (`teamId: null`) when a player played for multiple teams in a season.

## Referee data

API-Football exposes referees only as fixture strings (`"Name, Country"`). We normalize identity by name key. All referee statistics (cards per match, home/away cards, fouls, penalties, last 5/10/20) are **derived locally** from stored fixtures/events — the provider has no referee aggregate endpoints.

## Coverage limitations (by provider design)

- `players` coverage flag is FALSE for many competitions/seasons → no squad-wide season stats there (top-scorer lists may still exist).
- Event detail granularity varies by league (lower divisions may lack events/lineups entirely — see coverage flags).
- xG is available only for competitions where API-Football receives it (mostly top divisions); otherwise NULL.
- `sidelined` date ranges come from the player-centric endpoint; the bulk `/injuries` endpoint is fixture-scoped with type+reason only.
- Odds require an account with odds access; when unavailable, no odds rows are created.
- Some historical seasons have incomplete round/venue/referee information. `health/data` reports structural integrity, not provider completeness.

## How coverage is honored

`competition_season_coverage` stores the provider's own flags per season. The sync engine consults these flags before every detail fetch — unsupported endpoints are never called, which both saves quota and avoids meaningless 404s.
