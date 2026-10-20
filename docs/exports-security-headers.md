# Security headers on `/api/exports`

`GET /api/exports` (and every other response from that router) sets the following
headers via `securityHeadersMiddleware` (`src/middleware/securityHeaders.ts`):

| Header | Default value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; frame-ancestors 'none'; object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

Headers are applied at the router level (`router.use(...)`) so they appear on
both successful `200` responses and error responses (`401` / `403` / `400`).

The repo mounts this surface at **`/api/exports`** (plural). There is no
singular `/api/export` route.

Export routes are mounted only when `EXPORTS_ENABLED=true` and all required
S3 settings are valid. Otherwise `/api/exports` and `/api/exports/schedules`
are unavailable. Schedule endpoints reject private, loopback, link-local,
CGNAT, multicast, and IPv4-mapped IPv6 addresses; production requires HTTPS.
Set `EXPORTS_S3_ENDPOINT_ALLOWLIST` to constrain accepted hostnames further.

## Related

- Middleware: `src/middleware/securityHeaders.ts`
- Route: `src/routes/exports.ts`
- Tests: `src/routes/exports.test.ts` (`security headers` describe block)
