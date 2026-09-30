# Prediction app (reference implementation)

A small, complete prediction app that reads the Football Data Platform through
**our REST API with a `pf_live_…` key**, and can additionally train team
strengths straight from the **read-only** PostgreSQL replica.

```
Browser ──► this app (Node, port 3000) ──► platform API /api/v1  (X-API-Key: pf_live_…)
                     │                            │
                     │                            └── PostgreSQL warehouse (source of truth)
                     └── (optional, `npm run train`)
                         postgres://football_readonly:***@host/football   SELECT only
```

The API key never reaches the browser and the app never holds the API-Football
provider key.

## Quick start

```bash
cd examples/prediction-app
npm install
cp .env.example .env      # fill in FOOTBALL_API_BASE_URL + FOOTBALL_API_KEY
npm run dev               # http://localhost:3000
```

Using the SDK straight from this repository (it is a `file:` dependency)?
Build it once first, from the repo root:

```bash
npm --prefix sdk/typescript install   # once
npm run sdk:build                     # compiles sdk/typescript → dist/
```

Create a key first (in the platform repo):

```bash
npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read"
```

## What it does

1. `GET /fixtures/upcoming` — the next fixtures.
2. `GET /predictions/features/:id` — model-ready features computed by the
   platform (form, venue splits, goals/shots/corners/cards rates, clean-sheet /
   FTS / BTTS rates, league averages, referee profile, H2H, availability,
   lineups, freshness timestamps). No provider call happens on this path.
3. `GET /competitions/:id/statistics` — league baseline (home/away goals per
   match), cached 15 minutes per competition-season.
4. Turns those into goal expectations λ_home / λ_away with a multiplicative
   Poisson model, then into markets with a Dixon–Coles low-score correction:
   1X2, over/under 1.5 / 2.5 / 3.5, BTTS, double chance, top scorelines, fair odds.

## Model

```
λ_home = attack(home) · defence(away) · leagueHomeGoalsPerMatch · venueSplit(home)
λ_away = attack(away) · defence(home) · leagueAwayGoalsPerMatch · venueSplit(away)
```

Three things keep small samples honest:

* **shrinkage** — team rates are pulled toward the league average by `n / (n + K)` (`PREDICTION_SHRINKAGE_K`, default 6)
* **xG blending** — goals and expected goals are blended for the attack term (`PREDICTION_XG_WEIGHT`, default 0.5)
* **venue split** — home/away form acts as a damped multiplier (`PREDICTION_VENUE_WEIGHT`, default 0.35)

If a trained model exists it is blended in log space
(`PREDICTION_TRAINED_WEIGHT`, default 0.5 — geometric mean of the two λ's).

## Training on the warehouse (optional)

```bash
# once, in the platform repo — creates the SELECT-only role
npm run database:migrate
psql "$DATABASE_URL" -c "ALTER ROLE football_readonly PASSWORD '<secret>';"

# here
TRAIN_DATABASE_URL=postgres://football_readonly:<secret>@host:5432/football npm run train
```

* refuses to run if the connection can write (`assertReadOnly`)
* fits μ (baseline), home advantage, per-team attack/defence by weighted MLE
  (recent matches count more, half-life `PREDICTION_HALF_LIFE_DAYS`, default 400)
* grid-searches the Dixon–Coles ρ
* splits each competition chronologically: oldest 80 % train, newest 20 % test
* prints hold-out log-loss / accuracy / Brier and compares it to a
  league-average baseline, then writes `model/poisson-model.json`
* `--csv training-data.csv` also exports a **leakage-free** dataset (rolling
  features computed strictly before kickoff) for training your own model

> ⚠️ Do **not** train on `prediction_features` rows of finished matches: they are
> computed from the current database state and therefore contain the result.
> Use `fetchPointInTimeDataset()` / `--csv` instead.

### Reading the numbers

With the bundled mock provider (`API_FOOTBALL_KEY` empty) every team scores with
the same λ, so there is no team-quality signal to learn: the trained model lands
within noise of the league-average baseline. That is the correct answer for
synthetic data — with real API-Football history the hold-out log-loss should
drop below the baseline.

## Layout

```
src/
  config.ts                 env loading + validation (refuses to start without a key)
  server.ts                 Express UI + JSON API (the only place the key is used)
  predict/
    poisson.ts              Poisson + Dixon–Coles maths and market derivation
    baseline.ts             league baselines, cached per competition-season
    feature-model.ts        λ from platform prediction features
    trained-model.ts        λ from the trained model file
    index.ts                PredictionService: features → markets, batch scoring
  training/
    dataset.ts              read-only queries + point-in-time dataset + read-only guard
    fit.ts                  MLE fitter (μ, home advantage, attack, defence, ρ) + metrics
    train.ts                CLI: fetch → fit → evaluate → model.json
public/                     UI (vanilla JS)
model/poisson-model.json    generated by `npm run train` (git-ignored)
```

## Production notes

* Keep the app server-side; do not expose the key to browsers.
* Cache responses (this demo caches 60 s) and honour `X-RateLimit-Remaining-*`.
* Score batches with `predictionFeaturesBatch({ concurrency: 4 })` off-peak.
* Retrain weekly (`npm run train`) and keep the previous model until the new one
  beats it on the hold-out.
