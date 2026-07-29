# /api/errors Security Headers

Every response from `/api/errors` — across all verbs, status codes, and both
success and error paths — carries the following security headers as part of the
GrantFox FWC26 security header sweep (#945).

## Headers applied

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; frame-ancestors 'none'; object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

### Why each header matters

**Content-Security-Policy** — Restricts what resources the browser may load
when an API response is rendered in a browser context. `frame-ancestors 'none'`
prevents clickjacking; `object-src 'none'` blocks plugin-based attacks.

**X-Content-Type-Options: nosniff** — Instructs browsers not to MIME-sniff the
response away from the declared `Content-Type`, preventing content-confusion
attacks where a JSON response is executed as a script.

**Referrer-Policy: strict-origin-when-cross-origin** — Limits the `Referer`
header to the origin only when making cross-origin requests, protecting
potentially sensitive path information from leaking to third parties.

## Implementation

The middleware is applied as a router-level `use` at the top of
`createErrorsRouter` so it fires before every route handler — including before
`requireAuth`, meaning even `401 Unauthorized` and `400 Validation Error`
responses carry the headers:

```ts
// src/routes/errors.ts
router.use(securityHeadersMiddleware);
```

`securityHeadersMiddleware` is the shared default instance exported from
`src/middleware/securityHeaders.ts`. The same instance is used on
`/api/exports`, `/api/webhooks`, and `/api/admin/audit`.

## Coverage

`src/routes/errors.test.ts` contains a dedicated `describe` block
(`/api/errors security headers (#945)`) that asserts all three headers on:

| Verb | Path | Status codes covered |
|---|---|---|
| `GET` | `/api/errors` | 200 |
| `GET` | `/api/errors/:id` | 404 |
| `POST` | `/api/errors` | 201, 400, 401 |
| `PATCH` | `/api/errors/:id` | 200, 404 |
| `PUT` | `/api/errors/:id` | 200 |
| `DELETE` | `/api/errors/:id` | 204, 404 |

Run the focused tests with:

```bash
npx jest --forceExit --testPathPattern="src/routes/errors" --no-coverage
```

## Related

- Middleware implementation: `src/middleware/securityHeaders.ts`
- Middleware unit tests: `src/middleware/securityHeaders.test.ts`
- Same pattern on exports: `src/routes/exports.ts`
- Same pattern on webhooks: `src/webhooks/webhook.routes.ts`
- Same pattern on admin audit: `src/routes/admin/audit.ts`
