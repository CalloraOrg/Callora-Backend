# Forecast Access Logs

Structured JSON access logs for all `/api/forecast` endpoints, emitted with
correlation IDs, actor identity, latency, and response size for full
auditability of every forecast operation.

## Overview

Every request that flows through the `/api/forecast` router is wrapped by
`src/middleware/forecastAccessLog.ts`.  On response completion the middleware
emits a single structured JSON log entry on the `forecast` Pino channel.

This is separate from the global access log (`src/middleware/accessLog.ts`),
which samples all traffic at a configurable rate.  Forecast logs are **always
emitted** (100%) so that read and write activity on forecast data can be
independently monitored, alerted on, and correlated with audit events.

## Log Fields

| Field           | Type    | Description                                                          |
| --------------- | ------- | -------------------------------------------------------------------- |
| `correlationId` | string  | Resolved from `x-correlation-id`, then `x-request-id`, then UUID v4 |
| `requestId`     | string  | Sanitised `x-request-id` header, `req.id`, or generated UUID v4     |
| `method`        | string  | HTTP verb (`GET`, `POST`, `PATCH`, `DELETE`)                         |
| `path`          | string  | Request path (e.g. `/api/forecast` or `/api/forecast/forecast_abc`)  |
| `status`        | number  | HTTP response status code                                            |
| `statusCode`    | number  | Alias for `status` (compatibility with the global access-log format) |
| `ms`            | number  | Request latency in milliseconds (3 decimal places)                   |
| `durationMs`    | number  | Alias for `ms`                                                       |
| `responseBytes` | number  | Size of the HTTP response body in bytes                              |
| `userId`        | string? | Authenticated developer ID (from `res.locals.authenticatedUser`)     |
| `actor`         | string? | Alias for `userId` — surfaced for audit tooling queries              |
| `clientIp`      | string? | Client IP address (respects `TRUST_PROXY_HEADERS`)                   |
| `forecastId`    | string? | Route param `:id` when present (read, update, delete by ID)         |

## Log Levels

| Status range | Pino level |
| ------------ | ---------- |
| 5xx          | `error`    |
| 4xx          | `warn`     |
| 2xx / 3xx    | `info`     |

## Sample Log Entry

```jsonc
{
  "level": 30,
  "time": 1753480000000,
  "channel": "forecast",
  "correlationId": "req_a1b2c3d4",
  "requestId": "req_a1b2c3d4",
  "method": "GET",
  "path": "/api/forecast/forecast_abc123",
  "status": 200,
  "statusCode": 200,
  "ms": 12.847,
  "durationMs": 12.847,
  "responseBytes": 482,
  "userId": "dev-xyz",
  "actor": "dev-xyz",
  "forecastId": "forecast_abc123",
  "msg": "forecast request completed"
}
```

## Correlation ID Resolution

The middleware resolves IDs using the same priority chain as the billing and
exports logs:

1. `x-correlation-id` header (sanitised via `sanitizeRequestId`)
2. `x-request-id` header (sanitised)
3. `req.id` (set upstream by `requestIdMiddleware`)
4. Async-local request ID (set by `requestIdMiddleware`)
5. Generated UUID v4 (fallback — always present)

`sanitizeRequestId` strips ASCII control characters (CR, LF, NUL, …),
trims whitespace, rejects values longer than 128 characters, and returns
`undefined` for empty strings.  This prevents header injection attacks.

## Redaction

Sensitive fields can be redacted at the factory level:

```typescript
import { createForecastAccessLogMiddleware } from './forecastAccessLog.js';

router.use(
  createForecastAccessLogMiddleware({
    redactFields: ['path', 'userId'],
  }),
);
```

Redacted values are replaced with `[REDACTED]`.  Field matching is
case-insensitive.

## Wiring

The middleware is mounted as the first handler in the forecast router, after
the timeout middleware:

```typescript
// src/routes/forecast.ts
import { createForecastAccessLogMiddleware } from '../middleware/forecastAccessLog.js';

export function createForecastRouter(timeoutMs = 5_000): Router {
  const router = Router();
  router.use(createTimeoutMiddleware({ durationMs: timeoutMs }));
  router.use(createForecastAccessLogMiddleware());
  // …routes…
  return router;
}
```

This guarantees that every sub-route —
`GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` —
is covered, including error paths handled by the downstream `errorHandler`.

## Configuration

| Environment variable  | Default | Description                                                         |
| --------------------- | ------- | ------------------------------------------------------------------- |
| `TRUST_PROXY_HEADERS` | `false` | When `true`, honours `X-Forwarded-For` etc. for client IP extraction |

## Security

- **No raw user input** is written to logs without sanitisation.
- **Header injection** is prevented by stripping control characters from all
  correlation and request ID values.
- **PII**: only developer IDs (opaque internal identifiers) appear in log
  payloads, never names, email addresses, or credentials.
- **Redaction** is available for any field via `createForecastAccessLogMiddleware`.

## Relationship to Audit Logs

The forecast access log records HTTP metadata for **every** request (reads and
writes alike).  The audit log (`src/services/auditService.ts`) records
business-level before/after state changes for **state-mutating operations only**
(POST, PATCH, DELETE).

Both entries share the same `correlationId` / `requestId` value, so operators
can join the two records to reconstruct the full picture of what happened,
who did it, and what changed.

## Testing

Unit tests: `src/middleware/forecastAccessLog.test.ts`

Run with:

```bash
npm test -- forecastAccessLog
```
