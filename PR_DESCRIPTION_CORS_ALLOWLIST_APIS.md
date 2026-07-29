# PR: CORS allowlist enforcement on /api/apis

## Summary

Enforces a new env-driven, **deny-by-default** CORS allowlist (`APIS_CORS_ALLOWED_ORIGINS`) on every cross-origin request to the `/api/apis` endpoints:

- `GET /api/apis` (public listings)
- `GET /api/apis/:id` (public detail)
- `POST /api/apis` (authenticated creation)
- `POST /api/apis/:id/endpoints/bulk` (authenticated bulk addition)

When the env var is **unset** or **empty**, **every** cross-origin request — including those without an `Origin` header — is rejected with `403 ORIGIN_NOT_ALLOWED`. This matches the "deny by default" posture requested by the GrantFox FWC26 campaign.

The preflight response includes `Access-Control-Max-Age: 600` so browsers cache the result for 10 minutes. This provides a balance between rapid configuration invalidation and mitigating preflight latency.

## What's in this PR

### Modified files

| File | Change |
|---|---|
| `src/middleware/cors.ts` | Added `createApisCorsMiddleware` factory, which lazily reads `APIS_CORS_ALLOWED_ORIGINS`. Preflight cache is set to 10 minutes and `allowCredentials` is enabled for authenticated POST endpoints. |
| `src/routes/apis.ts` | Instantiated and mounted the new CORS middleware on the `apisRouter` before the route handlers. |
| `src/config/env.ts` | Added `APIS_CORS_ALLOWED_ORIGINS` to the env schema as a documentation-only string entry. |
| `.env.example` | Documented `APIS_CORS_ALLOWED_ORIGINS` with an example value and description of its deny-by-default behavior. |
| `src/middleware/cors.test.ts` | Added 5 integration tests covering: deny-by-default when empty, deny unallowed origins, allow valid origins, preflight caching, and credentials support. |

## Configuration

```bash
# Set this in production. Empty (the default) denies EVERY cross-origin
# request to /api/apis.
APIS_CORS_ALLOWED_ORIGINS=https://app.callora.com,https://api.callora.com
```

| Variable | Default | Purpose |
|---|---|---|
| `APIS_CORS_ALLOWED_ORIGINS` | `""` (deny-by-default) | Comma-separated exact-match origin list. Whitespace trimmed; duplicates removed; empty entries dropped. |

The middleware initialises lazily on the **first request** and caches the parsed list for the lifetime of the process, so changing this variable requires a restart to take effect.

## API / visible changes

1. **Tightened CORS on the apis route**: Cross-origin requests to `/api/apis` without an allowlisted `Origin` (and requests without any `Origin` at all) are now rejected at the boundary with `403`. Server-to-server callers must send the `APIS_CORS_ALLOWED_ORIGINS` allowlisted origin or call from the same origin as the API host.
2. **`Vary: Origin`** is set on every CORS response (allow, deny, preflight) so HTTP caches cannot leak one origin's payload to another.

## Security & privacy

- ✅ **No wildcards / no scheme-relative matches** — origin comparison is exact-string against the parsed allowlist.
- ✅ **Deny by default** — empty env var ⇒ all cross-origin denied.
- ✅ **Structured logging on every denial** — `logger.warn` is emitted with the origin and request id.
- ✅ **No state changes on deny** — the middleware responds with 403 immediately.
