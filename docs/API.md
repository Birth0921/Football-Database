# Our REST API

Base URL: `http://<host>:<port>` (spec-consistent paths under `/`). Interactive docs: **`/docs`** (Swagger UI), OpenAPI JSON: `/docs/json`.

## Authentication

All data endpoints require a platform API key:

```
X-API-Key: pf_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are created via the admin UI (`/admin/api-keys/ui`) or CLI (`api-key:create`). Every key has **scopes**; a route requiring a scope the key lacks gets `403`. Per-client rate limits (per minute / per day) return `429` when exceeded. Revoked/expired keys are rejected immediately (`403`).

Response envelope (consistent everywhere):

```json
{ "success": true, "data": { … }, "meta": { "pagination": { "page": 1, "perPage": 25, "total": 120, "totalPages": 5 } } }
{ "success": false, "error": { "status": 404, "message": "fixture not found" } }
```

List endpoints accept `?page=1&perPage=25` (max 100).

## Endpoints

### Health (public)
| Endpoint | Description |
|---|---|
| `GET /health` | Overall status (database/redis/provider-key) |
| `GET /health/database` | PostgreSQL latency + version |
| `GET /health/redis` | Redis latency |
| `GET /health/provider` | API-Football key + quota snapshot (`?refresh=1` re-checks `/status`) |
| `GET /health/data` | Row counts, data-quality checks, sync stats |

### Competitions (`standings:read` scope)
| Endpoint | Description |
|---|---|
| `GET /competitions?search=&country=&type=` | Paginated list |
| `GET /competitions/:id` | Single (internal or provider id) |
| `GET /competitions/:id/seasons` | Seasons incl. coverage flags |
| `GET /competitions/:id/statistics?season=` | League analytics (`statistics:read`) |

### Teams (`teams:read`)
| Endpoint | Description |
|---|---|
| `GET /teams?search=&country=&competition=` | Paginated |
| `GET /teams/:id` | Team + venue + seasons |
| `GET /teams/:id/statistics?competition=&season=` | Full team analytics (`statistics:read`) |

### Players (`players:read`)
| Endpoint | Description |
|---|---|
| `GET /players?search=&nationality=&team=` | Paginated |
| `GET /players/:id` | Profile + team history |
| `GET /players/:id/statistics?season=` | Season stats (per team + aggregate) (`statistics:read`) |

### Referees (`referees:read`)
| Endpoint | Description |
|---|---|
| `GET /referees?search=&country=` | Paginated (sorted by matches) |
| `GET /referees/:id` | Profile |
| `GET /referees/:id/statistics` | Per-season + per-competition + last 20 matches (`statistics:read`) |

### Fixtures (`fixtures:read`)
| Endpoint | Description |
|---|---|
| `GET /fixtures?competition=&season=&team=&status=&from=&to=&date=&referee=&venue=` | Filterable, paginated |
| `GET /fixtures/upcoming` | Next kickoffs |
| `GET /fixtures/live` | Currently live |
| `GET /fixtures/finished` | Most recent results |
| `GET /fixtures/:id` | Single fixture (scores incl. HT/FT/ET/PEN) |
| `GET /fixtures/:id/events` | Goals, cards, subs, VAR (provider strings preserved) |
| `GET /fixtures/:id/statistics` | Team stats for the match (`statistics:read`) |
| `GET /fixtures/:id/lineups` | Formation, coach, XI + subs |
| `GET /fixtures/:id/players` | Player match performances (`players:read`) |
| `GET /fixtures/:id/h2h` | Head-to-head from local data (`statistics:read`) |

### Standings (`standings:read`)
| Endpoint | Description |
|---|---|
| `GET /standings?competition=&season=` | Ranked table with home/away splits (`group=` for multi-group) |

### Statistics (`statistics:read`)
| Endpoint | Description |
|---|---|
| `GET /h2h?team1=&team2=&last=10&competition=` | Local H2H: results, goals, BTTS, cards, recent matches |

### Predictions (`predictions:read`)
| Endpoint | Description |
|---|---|
| `GET /predictions/features/:fixtureId` | **The prediction feature feed**: fixture, home/away overall + home/away-specific form, goals/shots/cards/possession averages and rates, league context, referee card profile, player availability (injuries), H2H, data freshness timestamps. Served from Redis → DB → on-demand local build. **Never calls API-Football at request time.** |

### Admin (`X-Admin-Token` header, not API keys)
| Endpoint | Description |
|---|---|
| `GET /admin/api-keys/ui` | Management dashboard (HTML) |
| `GET/POST /admin/clients`, `PATCH /admin/clients/:id` | Client registry (enable/disable, rate limits) |
| `GET /admin/api-keys` | Keys with prefixes, scopes, usage timestamps (never plaintext) |
| `POST /admin/api-keys` | Create key — **plaintext returned exactly once** |
| `POST /admin/api-keys/:id/rotate` | New key + grace period for old (default 24h) |
| `POST /admin/api-keys/:id/revoke` | Immediate revocation |
| `GET /admin/usage?days=7` | Usage per client/day |
| `GET /admin/sync` | Task stats + recent failures |
| `POST /admin/sync/retry-failed` | Requeue failed tasks |

## Example: prediction app integration

```bash
# .env of the prediction app — only OUR key, never API_FOOTBALL_KEY
FOOTBALL_API_BASE_URL=https://api.yourdomain.com
FOOTBALL_API_KEY=pf_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

curl -H "X-API-Key: $FOOTBALL_API_KEY" \
  "$FOOTBALL_API_BASE_URL/predictions/features/1035048"
```

Sample response (abridged):

```json
{
  "success": true,
  "data": {
    "version": 1,
    "fixture": { "id": 1035048, "kickoffAt": "…", "competition": "Premier League",
                 "homeTeam": "Manchester United", "awayTeam": "Liverpool", "referee": "Michael Oliver" },
    "home": { "overall": { "matches": 12, "wins": 8, "avgGoalsScored": 2.1, "bttsPct": 58, "formLast10": "WWDWLWWDLW", … },
              "homeSpecific": { "played": 6, "win": 5, "goalsFor": 14, … } },
    "away":  { "overall": { … }, "awaySpecific": { … } },
    "league": { "goalsPerMatch": 2.87, "bttsPct": 54, "cardsPerMatch": 4.2, … },
    "referee": { "matches": 9, "yellowCardsPerMatch": 4.1, "redCardsPerMatch": 0.11, "penaltiesPerMatch": 0.22, … },
    "playerAvailability": { "home": [ { "player": "…", "recordType": "missing", "reason": "Knee Injury" } ], "away": [] },
    "h2h": { "summary": { "matches": 10, "homeTeamWins": 4, "draws": 2, "awayTeamWins": 4 }, "last5": [ … ] },
    "dataFreshness": { "teamStatistics": "…", "leagueStatistics": "…", "computedAt": "…" }
  }
}
```
