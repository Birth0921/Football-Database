# API Keys (our own credential system)

There are **two separate credentials** in this platform:

| Credential | Who holds it | Used for |
|------------|--------------|----------|
| `API_FOOTBALL_KEY` | backend only | calling API-Football — never exposed to any client |
| `pf_live_…` keys | prediction app, website, integrations | calling **our** `/api/v1` |

## Key format & storage security

```
pf_live_<12-hex-handle>_<43-char base64url secret>
```

- generated with `crypto.randomBytes` (CSPRNG)
- the complete secret is displayed **once** (CLI output / admin modal)
- only `key_prefix` (lookup handle) and SHA-256 `key_hash` are stored —
  the raw key exists nowhere on disk or in PostgreSQL (verified by tests)

## Scopes

`fixtures:read`, `teams:read`, `players:read`, `referees:read`,
`standings:read`, `statistics:read`, `predictions:read`, `admin:read`,
`admin:write` (`admin:write` implies `admin:read`)

Recommended prediction-app set:
`fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read`

## CLI

```bash
# create (secret printed once)
npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,standings:read,statistics:read,predictions:read" \
  --label "prod" --expires 365

# rotate — new secret printed once; old key stays valid for the grace period
npm run api-key:rotate -- --key pf_live_65b13cf13839 --grace-hours 24
# (use --grace-hours 0 to kill the old key immediately)

# revoke — effective immediately, usage history retained
npm run api-key:revoke -- --key pf_live_65b13cf13839 --reason "compromised"

# list (prefixes only — never secrets)
npm run api-key:list
```

## Admin dashboard

`http://localhost:8080/admin/api-keys` (login `ADMIN_USER`/`ADMIN_PASSWORD`):

create clients → set per-minute/per-day rate limits → generate keys (one-time
secret modal with copy button) → view prefixes/scopes/last-used/managed state →
rotate with 24 h grace → revoke → **permanently delete** → view usage. After
the creation dialog is closed the secret can never be displayed again.

Admin API calls (`/admin/*`) require the admin Bearer token from
`POST /api/v1/admin/login` or an API key with `admin:*` scopes.

## Managed Website key (automatic)

The public website authenticates against our API with exactly one
**automatically managed** key — no configuration needed:

- created on first Website boot if missing (advisory lock + partial unique
  index on `api_keys.managed_role = 'website'` → never duplicates, even with
  concurrent workers)
- **read-only public scopes only** (`fixtures/teams/players/referees/standings/
  statistics/predictions:read`) — never `admin:*`
- **not regenerated on restart**: the raw key is stored encrypted at rest
  (AES-256-GCM, key derived from `JWT_SECRET`) and re-resolved on boot
- the browser never sees it — it lives only in the Website server process
  (Browser → Website proxy → internal `/api/v1`)
- if an admin permanently deletes it, the Website detects the auth failure on
  the next request, provisions a verified replacement and retries — no manual
  secret copying
- **no periodic rotation** (no timers). Rotate on demand from the Admin UI
  ("Rotate Key" on the Website row) or via
  `POST /api/v1/admin/api-keys/:id/rotate-website`: the replacement is created
  and verified **before** the old key is physically deleted; on any failure
  the old working key survives. The new secret is never returned — it stays
  server-side.

`SITE_API_KEY` (env) remains available as an operator override and disables
the managed mechanism while set.

## Permanent deletion

`DELETE /api/v1/admin/api-keys/:id` (admin auth) physically removes the key
row, its hash and any managed secret. The key stops authenticating
immediately, disappears from listings, and **cannot be recovered** (usage
history is retained with `api_usage.api_key_id = NULL`). Idempotent: deleting
an already-deleted key returns `deleted: false`. Only the key prefix is ever
shown in dialogs, responses or audit logs.

## Authentication pipeline (every request)

1. receive `X-API-Key`
2. derive `key_prefix` → 3. find key record → 4. constant-time hash compare →
5. revoked? (revocation is immediate, even during rotation grace) → 6. expired?
   → 7. client active? → 8. rotation grace closed? → 9. scope sufficient? →
10. per-minute + per-day rate limit (`api_usage`) → 11. record usage
(`api_usage`, `last_used_at`) → 12. handle request

The full key is never logged (pino redaction + secret scrubbing).

## Rotation without downtime (spec §8)

`rotate` mints a replacement key with `rotated_from` lineage and leaves the old
key active until `grace_until` (default 24 h). Swap the key in the consuming
app during the window; the old key dies when the window closes or when revoked.

## Usage tracking (spec §12)

`api_usage` rows per key/client/day/endpoint: requests, successful, failed,
rate-limited, last used. View via `GET /admin/usage` or the dashboard.

## Prediction app configuration (spec §58)

```env
FOOTBALL_API_BASE_URL=https://api.yourdomain.com/api/v1
FOOTBALL_API_KEY=pf_live_xxxxxxxxxxxxxxxx
```

The prediction app must contain **only** `FOOTBALL_API_KEY` (ours). If it ever
contains `API_FOOTBALL_KEY`, something is wrong.
