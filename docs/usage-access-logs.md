# Usage Access Logs

Structured JSON access logs for the usage endpoint, emitted with
correlation IDs for end-to-end request tracing.

## Overview

The usage `GET /` route in `src/routes/usage.ts` is wrapped by
`src/middleware/usageAccessLog.ts`.  On response completion the middleware
emits a single structured log entry on the `usage_access` Pino channel.

This is distinct from the global access log (`src/middleware/accessLog.ts`),
which samples all requests.  Usage logs are **always emitted** (100 %)
because usage queries are high-value for analytics and debugging.

## Log Fields

| Field           | Type     | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `correlationId` | string   | Correlation token from `x-correlation-id` or `x-request-id` header |
| `requestId`     | string   | Sanitised `x-request-id` header or generated UUID v4               |
| `method`        | string   | HTTP method (`GET`, …)                                             |
| `path`          | string   | Request path (e.g. `/`)                                            |
| `status`        | number   | HTTP response status code                                          |
| `statusCode`    | number   | Alias for `status`                                                 |
| `ms`            | number   | Request duration in milliseconds (3 decimal places)                |
| `durationMs`    | number   | Alias for `ms`                                                     |
| `requestBytes`  | number   | Size of the incoming request body in bytes                         |
| `responseBytes` | number   | Size of the outgoing response body in bytes                        |
| `userId`        | string?  | Authenticated user ID (from `res.locals.authenticatedUser`)        |
| `clientIp`      | string?  | Client IP address (respects `TRUST_PROXY_HEADERS`)                 |
| `apiId`         | string?  | Filtered API ID query parameter (from query string)                |
| `groupBy`       | string?  | Group-by query parameter (`day`, `week`, `month`)                  |
| `from`          | string?  | Start date query parameter (ISO-8601)                              |
| `to`            | string?  | End date query parameter (ISO-8601)                                |

## Log Levels

| Status range | Pino level |
| ------------ | ---------- |
| 5xx          | `error`    |
| 4xx          | `warn`     |
| 2xx / 3xx    | `info`     |

## Correlation ID Resolution

The middleware resolves the correlation ID in the following priority order:

1. `x-correlation-id` header (sanitised)
2. `x-request-id` header (sanitised)
3. `req.id` (set by `requestIdMiddleware`)
4. Async-local request ID (set by `requestIdMiddleware`)
5. Generated UUID v4

All header values are sanitised via `sanitizeRequestId()` which:

- Strips ASCII control characters (CR, LF, NUL, …) to prevent header injection
- Trims surrounding whitespace
- Discards values longer than 128 characters
- Returns `undefined` for empty/whitespace-only values

## ETag / 304 Caching

The usage `GET /` route also applies `etagMiddleware` (`src/middleware/etag.ts`),
which generates a weak ETag from the serialised response body.  Clients can
send `If-None-Match` to receive a `304 Not Modified` when the response has
not changed, reducing bandwidth and latency.

## Redaction

Sensitive fields can be redacted by passing `redactFields` to the middleware
factory:

```typescript
createUsageAccessLogMiddleware({
  redactFields: ['userId', 'path'],
});
```

Redacted values are replaced with `[REDACTED]`.  Field matching is
case-insensitive.

## Wiring

The middleware is mounted on the usage `GET /` route in `src/routes/usage.ts`:

```typescript
import { createUsageAccessLogMiddleware } from '../middleware/usageAccessLog.js';

const usageAccessLog = createUsageAccessLogMiddleware();
router.get('/', requireAuth, usageAccessLog, etagMiddleware, handler);
```

## Configuration

| Environment variable         | Default | Description                              |
| ---------------------------- | ------- | ---------------------------------------- |
| `TRUST_PROXY_HEADERS`        | `false` | When `true`, honours `X-Forwarded-For` etc. for client IP extraction |

## Security

- **No raw user input** is logged without sanitisation.
- **Header injection** is prevented by stripping control characters from
  correlation/request IDs.
- **PII** is not included in log payloads — only IDs and query parameters.
- **Redaction** is available for any field that should not appear in logs.

## Testing

Unit tests: `src/middleware/usageAccessLog.test.ts`
Route tests: `src/routes/usage.test.ts`

Run with:

```bash
npm test -- usageAccessLog
npm test -- usage.test
```
