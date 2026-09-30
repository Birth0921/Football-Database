# @football-data-platform/client

Official TypeScript/JavaScript client for the **Football Data Platform REST API**
(`/api/v1`). It authenticates with a platform-issued `pf_live_…` key — the
API-Football provider key is never involved and must never be pasted into a
client app.

* zero runtime dependencies (uses the global `fetch`; Node ≥ 18 or any browser)
* automatic retries with exponential backoff + jitter (429, 5xx, network)
* `Retry-After` honoured on rate limits; terminal errors (401/403/404) are not retried
* pagination helpers (`iterate`, `pages`, `all`)
* PostgreSQL numeric strings converted to numbers

## Install

```bash
npm install @football-data-platform/client        # published package
# or, inside this repo:
npm install ../sdk/typescript
```

## Use

```ts
import { FootballDataClient, NotFoundError } from '@football-data-platform/client';

const api = new FootballDataClient({
  baseUrl: process.env.FOOTBALL_API_BASE_URL!,   // https://api.yourdomain.com/api/v1
  apiKey: process.env.FOOTBALL_API_KEY!,         // pf_live_… (server-side only!)
});

// next fixtures
const { data: upcoming, pagination } = await api.fixturesUpcoming({ per_page: 25 });

// model-ready features for a fixture (no provider call happens on this path)
const { data: features } = await api.predictionFeatures(upcoming[0].id);

// every page of a listing without manual paging
for await (const fixture of api.iterate('/fixtures/upcoming')) {
  console.log(fixture.id, fixture.kickoff_utc);
}
```

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `baseUrl` | — | API root, e.g. `https://api.yourdomain.com/api/v1` |
| `apiKey` | — | platform key (`pf_live_…`) |
| `timeoutMs` | `15000` | per-request timeout |
| `maxRetries` | `3` | retries for 429 / 5xx / network errors |
| `retryBaseMs` | `400` | backoff base (exponential, with jitter, capped at 15 s) |
| `perPage` | `50` | default page size (max 100) |
| `coerceNumbers` | `true` | numeric strings → numbers |
| `stringFields` | `['code', …]` | keys that must stay strings |
| `fetch` | global | inject a custom fetch (tests, proxies) |
| `onRetry` | — | `({ attempt, waitMs, error }) => void` — alert on quota pressure |

### Errors

```
FootballApiError            base class (status, code, retryAfterSeconds)
├─ ValidationError          400
├─ AuthenticationError      401  (missing/unknown/revoked/expired key)
├─ PermissionError          403  (key lacks the required scope)
├─ NotFoundError            404  (e.g. features not built for that fixture)
├─ RateLimitError           429  (.retryAfterSeconds)
├─ ServerError              5xx
└─ NetworkError             DNS/TLS/timeout
```

```ts
import { RateLimitError, NotFoundError } from '@football-data-platform/client';

try {
  const { data } = await api.predictionFeatures(id);
} catch (err) {
  if (err instanceof RateLimitError) await sleep(err.retryAfterSeconds * 1000);
  else if (err instanceof NotFoundError) console.warn('features not built yet');
  else throw err;
}
```

### Rate limits

Every response updates `api.rateLimit` with `X-RateLimit-Remaining-Minute` /
`-Day`. Defaults are 60/minute and 10 000/day per client; raise them with
`PATCH /admin/clients/:id` or the admin dashboard.

### Batch scoring

```ts
const { features, failures } = await api.predictionFeaturesBatch(
  upcoming.map((f) => f.id),
  { concurrency: 4, onFeatures: (f) => score(f) },
);
```

Failures are collected, never thrown — one missing feature row should not kill a
scoring run.

## Notes

* The key travels in the `X-API-Key` header only — never in a URL, cookie or query string.
* Call it from a **server**, not from a browser: the platform API does not send
  CORS headers, and a key shipped to a browser is a key handed to the public.
* `coerceNumbers` turns `"1.333"` into `1.333`, which is what model code wants;
  timestamps stay ISO strings.

See [../../PREDICTION_APP.md](../../PREDICTION_APP.md) for the full integration
guide and [../../examples/prediction-app](../../examples/prediction-app) for a
runnable app built on this client.
