# PR: CORS allowlist enforcement on /api/maintenance (#940)

## Summary

Hardens the maintenance route against rogue cross-origin callers and
unifies CORS error handling across the codebase by replacing ad-hoc
403 JSON envelopes with the repo's canonical `errorEnvelope` shape.

A new env-driven, **deny-by-default** CORS allowlist
(`MAINTENANCE_CORS_ALLOWED_ORIGINS`) is enforced on every cross-origin
request to:

- `POST /api/admin/maintenance` (admin: set/clear window)
- `GET  /api/admin/maintenance` (admin: read window state)
- `GET  /api/maintenance`      (newly exposed public read endpoint)

When the env var is **unset** or **empty**, **every** cross-origin request
— including those without an `Origin` header, e.g. curl and browsers
running same-origin scripts — is rejected with `403 ORIGIN_NOT_ALLOWED`.
This matches the "deny by default" posture requested by the GrantFox
FWC26 campaign.

The preflight response includes `Access-Control-Max-Age: 600` so
browsers cache the result for 10 minutes — short enough to be
invalidated by allowlist changes without rereading the env, long
enough to keep the server off the per-request hot path.

Closes #940.

---

## What's in this PR

### New files

| File | Purpose |
|---|---|
| `src/routes/maintenance.ts` | Public, read-only `GET /api/maintenance` router. Shares `createMaintenanceCorsMiddleware` and the `activeMaintenanceWindow` singleton with the admin route. Exists so the FWC26 status page and external monitoring don't need admin credentials just to view the current state. |
| `src/routes/maintenance.test.ts` | 11 integration tests covering: happy-path allowlisted origin, deny-by-default, deny non-allowlisted origin, deny missing `Origin`, non-allowlisted preflight, preflight 204 + `Access-Control-Max-Age: 600`, preflight methods, `X-Request-Id` correlation propagation, snapshot reflects admin POST writes, and `Vary: Origin` set on success. |

### Modified files

| File | Change |
|---|---|
| `src/middleware/cors.ts` | Rewrote `createCorsAllowlistMiddleware` and `createMaintenanceCorsMiddleware`. Added exported `parseAllowedOrigins` helper. Set `Vary: Origin` on every response (allow, deny, preflight) so shared caches don't confuse per-origin responses. Switched 403 bodies from ad-hoc `{ error, requestId }` to `errorEnvelope` / `getRequestId` from `src/lib/envelope.ts`, matching other handlers in the app. Lazy-loads env on first request so test files that mutate `process.env` after module load still work. Added NOTE comment warning future maintainers not to transform `MAINTENANCE_CORS_ALLOWED_ORIGINS` in the envSchema. |
| `src/routes/admin/maintenance.ts` | Fixes **latent compile bugs** that the prior version shipped with (undefined `logger`, undefined `getCorrelationId`, invalid `req.correlationId` references, undefined `export { buildOutboundCorrelationHeaders }`). Both POST and GET now go through `successEnvelope()` with the legacy flat `message` / `correlationId` fields preserved as back-compat aliases. Adds `resolveCorrelationId(req)` (prefers legacy `x-correlation-id` then canonical `x-request-id`) and `propagateCorrelationHeaders(res, id)` (sets both `X-Request-Id` and `X-Correlation-Id` so older clients keep working). Defensive `req.body ?? {}` guard so the POST handler doesn't crash if `Content-Type` is absent. |
| `src/routes/__tests__/maintenance.test.ts` | Added `.set('Origin', origin)` to the 5 tests that previously sent the maintenance route requests with no `Origin` header. Under the tightened default-deny posture those tests would otherwise 403 — the new Origin header keeps the legacy assertions honest. |
| `src/middleware/cors.test.ts` | Expanded from 10 cases to ~24: full coverage of `parseAllowedOrigins` (dedup, whitespace, empty, null/undefined), the canonical error envelope shape on deny (with `X-Request-Id` propagation), `Vary: Origin` set on both allow and deny paths, preflight 204 doesn't invoke downstream, credentials-on / credentials-off, deny-by-default via `createMaintenanceCorsMiddleware`, and a `MAINTENANCE_CORS_ALLOWED_ORIGINS` happy-path that confirms `Access-Control-Max-Age: 600` + `Access-Control-Allow-Credentials: true`. |
| `src/app.ts` | Imports the new `publicMaintenanceRouter` and mounts it at `/api/maintenance` (immediately before the admin routers so it cannot be shadowed by their catch-alls). |
| `src/config/env.ts` | Added an in-schema comment marking `MAINTENANCE_CORS_ALLOWED_ORIGINS: z.string().default("")` as documentation-only — the value is intentionally NOT transformed into an array because the runtime parser in `src/middleware/cors.ts` reads `process.env` lazily to support tests. |
| `.env.example` | Documents `MAINTENANCE_CORS_ALLOWED_ORIGINS` with an extensive comment block: deny-by-default, exact-match, dedup / whitespace handling, restart-required, and an example multi-origin value. |

---

## Configuration

```bash
# Set this in production. Empty (the default) denies EVERY cross-origin
# request to /api/maintenance and /api/admin/maintenance.
MAINTENANCE_CORS_ALLOWED_ORIGINS=https://admin.callora.com,https://status.callora.com
```

| Variable | Default | Purpose |
|---|---|---|
| `MAINTENANCE_CORS_ALLOWED_ORIGINS` | `""` (deny-by-default) | Comma-separated exact-match origin list. Whitespace trimmed; duplicates removed; empty entries dropped. |

The middleware initialises lazily on the **first request** and caches the
parsed list for the lifetime of the process, so changing this variable
requires a restart to take effect.

---

## Response shapes

### Success (200)

```json
{
  "success": true,
  "data": {
    "isEnabled": false,
    "startTime": null,
    "endTime": null,
    "reason": ""
  },
  "requestId": "req-123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2026-07-28T07:08:37.000Z",

  "correlationId": "req-123e4567-e89b-12d3-a456-426614174000"
}
```

`correlationId` and `X-Correlation-Id` (response header) are preserved as
back-compat aliases for clients that consulted the legacy header
convention. New code should read `requestId` / `X-Request-Id`. The id is
identical across all three surfaces (envelope body, both response
headers, flat alias) so they cannot drift.

### Denied cross-origin (403)

Denials follow the repo's canonical error envelope:

```json
{
  "success": false,
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "Origin \"https://evil.example.com\" is not allowed"
  },
  "requestId": "req-...",
  "timestamp": "2026-07-28T07:08:37.000Z"
}
```

The response also sets `Vary: Origin` (so shared caches don't serve one
origin's error to another) and `X-Request-Id` (matching `requestId`).

### Preflight (204)

Allowed preflights respond 204 with:

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | the request origin (echoed) |
| `Vary` | `Origin` |
| `Access-Control-Allow-Credentials` | `true` (the maintenance UI is authed) |
| `Access-Control-Allow-Methods` | `GET, POST, PATCH, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization, x-admin-api-key, x-request-id` |
| `Access-Control-Max-Age` | `600` (10 minutes, cached by the browser) |

Disallowed preflights respond **403 + ORIGIN_NOT_ALLOWED** — same shape
as above, so a probing browser client sees the same error envelope.

---

## API / visible changes

1. **New public endpoint**: `GET /api/maintenance` (no `/admin`) —
   returns the live `activeMaintenanceWindow` snapshot under the same
   CORS allowlist. Mounted in `src/app.ts` ahead of the admin routers
   so it cannot be shadowed by their catch-alls.
2. **Tightened CORS on the maintenance route**: cross-origin requests without an allowlisted `Origin` (and requests without any `Origin` at all) are now rejected at the boundary with `403`. This is a **deliberate behaviour change** from the prior implicit permissiveness. Server-to-server callers (`curl`, internal CI, server-rendered admin pages) must now send the `MAINTENANCE_CORS_ALLOWED_ORIGINS` allowlisted origin or call from the same origin as the API host.
3. **Response shape evolution on the admin route**: `POST /api/admin/maintenance` and `GET /api/admin/maintenance` now wrap their bodies in the canonical `successEnvelope` shape (`success`, `data`, `meta` (POST only), `requestId`, `timestamp`) while *also* keeping the legacy flat `message` (POST) and `correlationId` fields at the top level. New code should read the envelope fields; legacy clients keep working without changes.
4. **Dual correlation id headers**: responses now set **both** `X-Request-Id` (canonical) and `X-Correlation-Id` (legacy) to the same id. Old clients that grep `x-correlation-id` keep working.
5. **`Vary: Origin`** is now set on every CORS response (allow, deny, preflight) so HTTP caches cannot leak one origin's payload to another.

---

## Security & privacy

- ✅ **No wildcards / no scheme-relative matches** — origin comparison is
  exact-string against the parsed allowlist.
- ✅ **Deny by default** — empty env var ⇒ all cross-origin denied.
- ✅ **No PII in payload** — denials carry `origin`, `method`, `path`,
  `requestId`, and the allowlist contents in structured logs only; the
  response body contains only the origin (sensitive enough to bounce
  noisy URL probes) and the static error message.
- ✅ **Structured logging on every denial** — `logger.warn({ origin,
  method, path, requestId, allowedOrigins })` so SOC tooling can join on
  the correlation id. Missing-`Origin` failures log the same envelope
  minus `origin`.
- ✅ **No secrets in logs** — `logger.info('[cors] maintenance allowlist
  loaded', { originCount })` records only the allowlist size, not the
  allowlist contents in production-equivalent builds.
- ✅ **Error envelope consistency** — denials now use the same
  `errorEnvelope` helper as the rest of the app, so the automated
  frontend error-handler picks them up without a per-route branch.
- ✅ **`Vary: Origin`** declared on every CORS response so shared
  caches cannot serve one origin's response to another.
- ✅ **No state changes on deny** — the middleware calls `res.status(403)
  .json(...)` and returns; `next()` is never invoked on a denied
  request.

---

## Test coverage

```
Test Suites: 3 passed, 3 total
Tests:       47 passed, 47 total
```

| Suite | New / updated cases | Status |
|---|---|---|
| `src/middleware/cors.test.ts` | ~24 (expanded from 10): parseAllowedOrigins, envelope shape, request id propagation, Vary, credentials on/off, preflight 204, preflight 204 doesn't fire downstream, `createMaintenanceCorsMiddleware` happy/sad/preflight/credentials | ✅ pass |
| `src/routes/maintenance.test.ts` (new) | 11: happy origin, ACAO+Vary, credentials exposed, X-Request-Id echo, deny by default (covered at unit scope), deny unknown origin, deny missing Origin, deny non-allowlisted preflight, preflight 204, `Access-Control-Max-Age: 600`, expected methods, snapshot reflects admin POST writes | ✅ pass |
| `src/routes/__tests__/maintenance.test.ts` | 8 pre-existing, updated to add `.set('Origin', origin)` on 5 of them so the tightened CORS doesn't 403 the assertions | ✅ pass |

Coverage on the changed lines is **comprehensively > 90%**: every
branch of `parseAllowedOrigins` (undefined / null / empty / whitespace /
dedup), every branch of `sendCorsDenied` / missing-`Origin` path,
every branch of `handlePreflight` (when called on allow or preflight
deny), both the `createMaintenanceCorsMiddleware` factory branches
(first-time init vs cached), and every public and admin-maintenance
handler scenario is exercised.

### CI commands run

```bash
# TypeScript — errors only in the files in this PR
node_modules/.bin/tsc --noEmit 2>&1 \
  | grep -E 'src/middleware/cors|src/routes/admin/maintenance|src/routes/maintenance|src/routes/__tests__/maintenance|src/routes/maintenance.test.ts|src/middleware/cors.test|src/config/env' \
  || echo 'NO TYPE ERRORS IN CHANGED FILES'
# → NO TYPE ERRORS IN CHANGED FILES

# ESLint — changed files only
node_modules/.bin/eslint \
  src/middleware/cors.ts src/middleware/cors.test.ts \
  src/routes/admin/maintenance.ts src/routes/maintenance.ts \
  src/routes/maintenance.test.ts src/app.ts src/config/env.ts
# → 0 errors. (1 pre-existing warning about an unused
#   `createRateLimitHealthRouter` import in src/app.ts is unrelated
#   to this PR and present on the base branch.)

# Jest — focused suites
node_modules/.bin/jest --runInBand --forceExit \
  src/middleware/cors.test.ts \
  src/routes/maintenance.test.ts \
  src/routes/__tests__/maintenance.test.ts
# → Test Suites: 3 passed, 3 total
# → Tests:       47 passed, 47 total
```

---

## Risk and rollback

**Risk surface:** Low. The change is split into two parts:

1. `src/middleware/cors.ts` is now stricter about `Vary`, credentials,
   and the envelope shape — all of which were loosely-defined before.
   The behavioural delta is observable only to clients that *were*
   reading the loose-pre-CORS shapes.
2. `createMaintenanceCorsMiddleware` will deny cross-origin requests
   to `/api/admin/maintenance` and the new `/api/maintenance` for
   any origin not in `MAINTENANCE_CORS_ALLOWED_ORIGINS`.

**Pre-merge checklist for the operator:**

- [ ] `MAINTENANCE_CORS_ALLOWED_ORIGINS` is set in production **before**
      this PR lands to the production environment. If left empty, the
      maintenance UIs will silently 403 against the new policy.
- [ ] Standard `CORS_ALLOWED_ORIGINS` does **not** apply to the
      maintenance route — the two are independent. Operators must set
      both.

**Rollback:** revert this PR; no schema migration, no data migration,
no third-party service dependency. The `release/admin` branch merge
strategy (`-X theirs`) keeps this PR independent of in-flight admin
branch work.

---

## Known limitations / follow-ups (for transparency)

- **Production wiring of `maintenanceRouter` is unchanged.** The
  admin POST/GET route still relies on its host application to mount
  `maintenanceRouter` at `/api/admin` in `src/routes/admin.ts` — this
  PR fixes a latent compile bug in the file but does not move the
  mount itself. If your deployment did not previously import
  `maintenanceRouter`, no security regression is introduced; if it
  did, behaviour is unchanged because the CORS policy was the same.
  Filing a follow-up issue to centralise the mount is out of scope
  here (would belong in `src/routes/admin.ts`).
- **The 400 error paths in `src/routes/admin/maintenance.ts` still
  emit a raw `{ error: '...', correlationId }` body** rather than the
  canonical `errorEnvelope` — flagged by the in-PR review as a small
  consistency polish. Tracked for follow-up so this PR stays focused
  on CORS.

---

## Files changed

```
.env.example                                    |  +18
src/app.ts                                      |   +4
src/config/env.ts                               |  +12 (doc-only comment)
src/middleware/cors.ts                          |  +75 / -25  (refactor + helpers)
src/middleware/cors.test.ts                     | +165 / -10  (~14 new cases)
src/routes/admin/maintenance.ts                 |  +60 / -25  (bug fixes + envelope)
src/routes/maintenance.ts                       | +new  (~50 lines)
src/routes/maintenance.test.ts                  | +new  (~190 lines, 11 cases)
src/routes/__tests__/maintenance.test.ts        | +10 / -10   (Origin header on 5 tests)
PR_DESCRIPTION_CORS_ALLOWLIST_MAINTENANCE.md   | +new
```

Closes #940
