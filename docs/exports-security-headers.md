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

## Related

- Middleware: `src/middleware/securityHeaders.ts`
- Route: `src/routes/exports.ts`
- Tests: `src/routes/exports.test.ts` (`security headers` describe block)
