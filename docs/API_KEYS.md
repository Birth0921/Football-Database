# API Keys (our platform keys)

Two completely separate credential systems exist:

| Credential | Used by | Stored |
|---|---|---|
| `API_FOOTBALL_KEY` | Our backend → API-Football only | Environment/secret store. **Never** in responses, logs, frontend, or Git |
| `pf_live_…` platform keys | Prediction App / Website / any client → Our API | PostgreSQL as `key_prefix` + HMAC-SHA256 hash **only** |

## Format & storage

- Format: `pf_live_` + 43 base64url chars from 32 cryptographic random bytes (~192-bit entropy)
- Lookup prefix: first 12 chars (`pf_live_XXXXXXXX`) — identification only
- Verification: HMAC-SHA256 with server pepper (`API_KEY_PEPPER`), constant-time compare
- The full plaintext is displayed **once** at creation and never stored or shown again

## Lifecycle

### Create
```bash
npm run cli -- api-key:create --client "Prediction App" \
  --scopes "fixtures:read,teams:read,standings:read,statistics:read,predictions:read"
```
(Client is auto-created if unknown.) Or via admin API/`/admin/api-keys/ui`.

Scopes: `fixtures:read teams:read players:read referees:read standings:read statistics:read predictions:read admin:read admin:write` and `*` (all). Prediction apps should get only the read scopes they need — never admin.

### Rotate (zero-downtime)
```bash
npm run cli -- api-key:rotate --id=42 --grace-hours=24
```
A new key is issued immediately; the old key keeps working until the grace window ends, then is revoked automatically. The rotation event is recorded in `sync_state`.

### Revoke (immediate)
```bash
npm run cli -- api-key:revoke --id=42 --reason "compromised"
```
The key stops authenticating on the next request. Historical `api_usage` rows are preserved.

### Inspect
```bash
npm run cli -- api-key:list
GET /admin/api-keys        # admin token required
GET /admin/usage?days=7
```

## Authentication pipeline (every request)

1. Read `X-API-Key`
2. Prefix lookup → key record
3. Constant-time HMAC verification
4. Revoked? expired? client disabled? → reject (403)
5. Scope check for the route → 403 if missing
6. Per-client rate limits (minute + day, Redis counters) → 429
7. Record usage (`api_usage` + `last_used_at`), fire-and-forget
8. Process request

The full key is never logged (redaction on `x-api-key`/`authorization` headers).

## Rotating the pepper

`API_KEY_PEPPER` (falls back to `ADMIN_TOKEN`, then JWT_SECRET) is mixed into every hash. Changing it invalidates **all** existing platform keys instantly — treat it as production secret and rotate deliberately (issue new keys afterward).
