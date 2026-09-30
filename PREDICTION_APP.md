# Building a prediction app on this platform

How an external application (prediction app, dashboard, bot, notebook) consumes
this platform. Two credentials exist and they are **never** interchangeable:

| Credential | Who holds it | Used for |
|------------|--------------|----------|
| `API_FOOTBALL_KEY` | **platform backend only** | calling API-Football |
| `pf_live_…` (ours) | your prediction app | calling **our** `/api/v1` |

If your app ever contains `API_FOOTBALL_KEY`, something is wrong. It only ever
needs `FOOTBALL_API_BASE_URL` and `FOOTBALL_API_KEY` (ours).

```
                  ┌──────────────────────────────────────────────┐
   Browser ──────►│ your prediction app (server-side!)           │
                  │   FOOTBALL_API_KEY = pf_live_…  (env/secret) │
                  └───────────────┬──────────────────────────────┘
                                  │ X-API-Key: pf_live_…
                                  ▼
                     our REST API  /api/v1  (HTTPS, rate-limited)
                                  │
                          PostgreSQL + Redis (internal only)

   Optional, training only:
   your trainer ──► postgres://football_readonly:***@host/football   (SELECT only)
```

---

## 1. Make the API reachable

The prediction app needs a stable base URL. Anything you can deploy Node to
works — see [DEPLOYMENT.md](DEPLOYMENT.md). Then:

```bash
curl https://api.yourdomain.com/api/v1/health
# {"ok":true,"status":"alive",...,"providerMode":"live"}
```

That URL (including `/api/v1`) is `FOOTBALL_API_BASE_URL`. Put TLS in front of
it — a `pf_live_` key sent over plain HTTP is a key handed to anyone on the path.

> There are **no CORS headers** on the API, by design. Call it from a server, not
> from browser JavaScript. If you build a browser UI, proxy through your own
> backend (exactly like [examples/prediction-app](examples/prediction-app)).

## 2. Create a client and a key

A *client* owns the rate limits and the audit trail; *keys* belong to it.

```bash
# one-off: create the client (rate limits are per client)
npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read" \
  --label "prod" --expires 365
```

The secret is printed **once**. Or use the admin dashboard
(`/admin/api-keys`, login `ADMIN_USER`/`ADMIN_PASSWORD`).

Scopes — give the app only what it needs:

| Scope | Prediction app needs it? |
|-------|--------------------------|
| `fixtures:read` | ✅ fixtures, lineups, events |
| `predictions:read` | ✅ `/predictions/features/:id` — the core endpoint |
| `statistics:read` | ✅ team/league/referee statistics, standings |
| `teams:read` | ✅ competitions, teams |
| `players:read` | ✅ player data, availability context |
| `referees:read` | ✅ referee profiles |
| `admin:read` / `admin:write` | ❌ never for a prediction app |

Defaults are **60 requests/minute and 10 000/day per client**. A nightly scoring
run of ~2 000 fixtures fits; if you need more, raise it deliberately:

```bash
curl -X PATCH -H "X-API-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"rate_limit_per_minute": 240, "rate_limit_per_day": 200000}' \
  "https://api.yourdomain.com/api/v1/admin/clients/1"
```

### Store the key

* env var / secret manager (Doppler, Vault, AWS Secrets Manager, GitHub Actions secret)
* never in git, never in a browser bundle, never in a URL, never in a log
* rotate on a schedule, immediately if it leaks

```bash
npm run api-key:rotate -- --key pf_live_2931b802d8be --grace-hours 24
npm run api-key:revoke -- --key pf_live_2931b802d8be --reason "leaked in a screenshot"
```

## 3. Choose your data path

| | REST API (recommended) | Read-only PostgreSQL (training only) |
|---|---|---|
| Endpoints | `/api/v1` with `pf_live_…` | `postgres://football_readonly:***…` |
| Best for | live scoring, apps, dashboards | bulk history, model fitting, backtests |
| Caching | Redis, tuned TTLs | none — you are reading the warehouse |
| Limits | per-minute / per-day quota | connection count (pool it!) |
| Schema stability | stable contract | can change with migrations |
| Risk if leaked | revoke one key | attacker reads your whole warehouse |

**Do both**: train on the warehouse, serve predictions from the API.

## 4. Call it

### With the SDK (recommended)

```bash
npm install @football-data-platform/client          # published package
npm install ../sdk/typescript                       # or straight from this repo
# from the repo root, when using the local path:  npm --prefix sdk/typescript install && npm run sdk:build
```

```ts
import { FootballDataClient } from '@football-data-platform/client';

const api = new FootballDataClient({
  baseUrl: process.env.FOOTBALL_API_BASE_URL!,
  apiKey: process.env.FOOTBALL_API_KEY!,
});

const { data: upcoming } = await api.fixturesUpcoming({ per_page: 50 });
const { features, failures } = await api.predictionFeaturesBatch(
  upcoming.map((f) => f.id),
  { concurrency: 4 },
);
```

The client retries 429/5xx/network errors with exponential backoff, honours
`Retry-After`, never retries 401/403/404, and exposes typed errors
(`AuthenticationError`, `RateLimitError`, `NotFoundError`, …). See
[sdk/typescript/README.md](sdk/typescript/README.md).

### Or plain HTTP

```bash
curl -H "X-API-Key: $FOOTBALL_API_KEY" \
  "$FOOTBALL_API_BASE_URL/predictions/features/12345"
```

## 5. The prediction loop

| Step | Call | Notes |
|------|------|-------|
| 1 | `GET /fixtures/upcoming?per_page=50` | pre-flight |
| 2 | `GET /predictions/features/:id` | one per fixture; batch with concurrency 4–8 |
| 3 | `GET /competitions/:id/statistics?season_id=` | league baseline, **cache per competition-season** |
| 4 | your model | λ → markets (see `examples/prediction-app`) |
| 5 | `GET /fixtures/live` | optional in-play dashboard (30 s cache) |

`GET /predictions/features/:id` returns everything needed for a match model:
recent form (overall + venue split) with points per game, goals/conceded/shots/
shots-on-target/possession/corners/cards/fouls averages, clean-sheet / failed-to-
score / BTTS rates, league averages, referee card-foul-penalty profile, local H2H
(last 20), player availability, lineups when published, and freshness timestamps.
It is computed by the platform — **no provider call happens per prediction**, so
it is fast and does not burn quota.

Response shape:

```json
{ "ok": true, "data": { ... } , "pagination": { "page": 1, "per_page": 25, "total": 851, "total_pages": 35 } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

Codes: `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `VALIDATION`,
`INTERNAL`. Rate-limited responses carry `Retry-After`; every response carries
`X-RateLimit-Remaining-Minute` / `-Day`.

### Etiquette (keeps you off the 429 page)

* one `predictionFeaturesBatch` pass for the day's card, not one per page view
* cache: fixture detail 2 min, prediction features 5 min, standings 10 min,
  statistics 15 min — the platform already caches; do not defeat it
* back off on 429 using `Retry-After`; do not retry 401/403/404
* run bulk scoring off-peak, and watch `api.rateLimit.remainingMinute`

## 6. Training on the warehouse

```bash
# 1. create the SELECT-only role (migration 0008) and give it a password
npm run database:migrate
psql "$DATABASE_URL" -c "ALTER ROLE football_readonly PASSWORD '<secret>';"

# 2. train (reference implementation)
cd examples/prediction-app
TRAIN_DATABASE_URL=postgres://football_readonly:<secret>@host:5432/football npm run train
```

What you get:

* `football_readonly` — `SELECT` on all tables (and future ones via default
  privileges), no `INSERT`/`UPDATE`/`DELETE`
* `prediction_training_matches` — a stable view: completed matches with
  team/competition/season names
* a reference fitter (`μ`, home advantage, per-team attack/defence, Dixon–Coles
  ρ) with a chronological 80/20 split and hold-out metrics against a
  league-average baseline
* `--csv training-data.csv` — rolling pre-match features computed with SQL
  `LATERAL` strictly before kickoff

> ⚠️ **Leakage.** `prediction_features` rows for *finished* matches are computed
> from the current database state and therefore include the match itself. Models
> trained on them look brilliant and fail in production. Use the point-in-time
> query (`fetchPointInTimeDataset()` / `--csv`) or split strictly by kickoff
> time, and never tune on the hold-out you report.

Rules: pool your connections (a handful, not one per worker), do not write
anything, do not run heavy queries against the primary during live sync — use a
replica if you have one.

## 7. Run the reference app

```bash
cd examples/prediction-app
npm install
cp .env.example .env        # FOOTBALL_API_BASE_URL + FOOTBALL_API_KEY
npm run dev                 # http://localhost:3000
```

It shows upcoming fixtures with 1X2 / over-under / BTTS probabilities, expected
goals, a score grid and the exact inputs the model used — a working template to
copy, not a product.

## 8. Go-live checklist

- [ ] API is on HTTPS behind a stable hostname; `GET /health` reachable
- [ ] Prediction app has its own client + key, read-only scopes only
- [ ] Key lives in a secret manager; `.env` is git-ignored; CI gets it as a secret
- [ ] App runs server-side (no key in the browser, no CORS dependency)
- [ ] Retries honour `Retry-After`; 401/403/404 are not retried
- [ ] Caching in place for baselines and scored cards
- [ ] Rotation runbook: rotate with 24 h grace, deploy the new key, revoke the old
- [ ] Usage reviewed (`GET /admin/usage`) and alerting on unusual spikes
- [ ] Training runs on the read-only role; hold-out metrics recorded per retrain
- [ ] `API_FOOTBALL_KEY` appears nowhere in the app, its env, or its logs

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 invalid api key` | wrong/expired/revoked key, or the provider key by mistake | issue a new `pf_live_` key |
| `403 missing required scope` | key lacks e.g. `predictions:read` | create a key with the scopes from step 2 |
| `404 … features not built yet` | features not computed for that fixture | `npm run prediction-features:rebuild` |
| `429` during a batch | per-minute quota | lower `concurrency`, honour `Retry-After`, raise the client limit |
| `ECONNREFUSED` from the browser | app called the API directly from the client | call your backend; it calls the API |
| Empty `/fixtures/upcoming` | nothing imported yet | `npm run competitions:import && npm run historical:import` |
| Model no better than baseline | little signal (mock data) or leakage in evaluation | check `providerMode`, use point-in-time features |
| `TRAIN_DATABASE_URL is not read-only` | wrong role | use `football_readonly` from migration 0008 |

## Related docs

[API.md](API.md) · [API_KEYS.md](API_KEYS.md) · [DATABASE.md](DATABASE.md) ·
[DATA_DICTIONARY.md](DATA_DICTIONARY.md) · [DEPLOYMENT.md](DEPLOYMENT.md) ·
[sdk/typescript](sdk/typescript) · [examples/prediction-app](examples/prediction-app)
