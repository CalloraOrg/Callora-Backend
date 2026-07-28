# Exports Access Logs

Structured JSON access logs for all `/api/exports/*` endpoints, emitted with
correlation IDs, actor identity, and latency for full auditability of every
export schedule operation.

## Overview

Every request that flows through the `/api/exports/schedules` router is
wrapped by `src/middleware/exportsAccessLog.ts`.  On response completion the
middleware emits a single structured JSON log entry on the `exports` Pino
channel.

This is separate from the global access log (`src/middleware/accessLog.ts`),
which samples all traffic at a configurable rate.  Export logs are **always
emitted** (100 %) because export schedule operations create, update, or read
potentially sensitive configuration (S3 credentials, cron schedules) and must
be fully auditable.

## Log Fields

| Field           | Type     | Description                                                          |
| --------------- | -------- | -------------------------------------------------------------------- |
| `correlationId` | string   | Resolved from `x-correlation-id`, then `x-request-id`, then UUID v4 |
| `requestId`     | string   | Sanitised `x-request-id` header, `req.id`, or generated UUID v4     |
| `method`        | string   | HTTP verb (`GET`, `POST`, `PATCH`)                                   |
| `path`          | string   | Request path (e.g. `/api/exports/schedules`)                         |
| `status`        | number   | HTTP response status code                                            |
| `statusCode`    | number   | Alias for `status` (compatibility with the global access-log format) |
| `ms`            | number   | Request duration in milliseconds (3 decimal places)                  |
| `durationMs`    | number   | Alias for `ms`                                                       |
| `responseBytes` | number   | Size of the HTTP response body in bytes                              |
| `userId`        | string?  | Authenticated developer ID (from `res.locals.authenticatedUser`)     |
| `actor`         | string?  | Alias for `userId` — surfaced for audit tooling queries              |
| `clientIp`      | string?  | Client IP address (respects `TRUST_PROXY_HEADERS`)                   |
| `scheduleId`    | string?  | Route param `:scheduleId` (present on `PATCH` operations)            |

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
  "channel": "exports",
  "correlationId": "req_a1b2c3d4",
  "requestId": "req_a1b2c3d4",
  "method": "PATCH",
  "path": "/api/exports/schedules/sched-42",
  "status": 200,
  "statusCode": 200,
  "ms": 14.231,
  "durationMs": 14.231,
  "responseBytes": 312,
  "userId": "dev-xyz",
  "actor": "dev-xyz",
  "scheduleId": "sched-42",
  "msg": "exports request completed"
}
```

## Correlation ID Resolution

The middleware resolves IDs using the same priority chain as the billing log:

1. `x-correlation-id` header (sanitised via `sanitizeRequestId`)
2. `x-request-id` header (sanitised)
3. `req.id` (set upstream by `requestIdMiddleware`)
4. Async-local request ID (set by `requestIdMiddleware`)
5. Generated UUID v4 (fallback — always present)

`sanitizeRequestId` strips ASCII control characters (CR, LF, NUL, …),
trims whitespace, rejects values longer than 128 characters, and returns
`undefined` for empty strings.

## Redaction

Sensitive fields can be redacted at the factory level:

```typescript
import { createExportsAccessLogMiddleware } from './exportsAccessLog.js';

router.use(
  createExportsAccessLogMiddleware({
    redactFields: ['path', 'userId'],
  }),
);
```

Redacted values are replaced with `[REDACTED]`. Matching is case-insensitive.

## Wiring

The middleware is mounted as the first handler in the exports router, before
`requireAuth` and route-specific handlers:

```typescript
// src/routes/exports/schedules.ts
import { exportsAccessLogMiddleware } from '../../middleware/exportsAccessLog.js';

export function createExportSchedulesRouter(service: ScheduledExportsService): Router {
  const router = Router();
  router.use(exportsAccessLogMiddleware);
  // …routes…
  return router;
}
```

This guarantees that every sub-route — `GET /`, `POST /`, `PATCH /:scheduleId`
— is covered, including error paths that are handled by the downstream
`errorHandler`.

## Configuration

| Environment variable  | Default | Description                                                         |
| --------------------- | ------- | ------------------------------------------------------------------- |
| `TRUST_PROXY_HEADERS` | `false` | When `true`, honours `X-Forwarded-For` etc. for client IP extraction |

## Security

- **No raw user input** is written to logs without sanitisation.
- **Header injection** is prevented by stripping control characters from all
  correlation and request ID values.
- **PII**: only developer IDs (opaque internal identifiers) appear in log
  payloads, never names, email addresses, or S3 credentials.
- **S3 secrets** are never present in the access log — they are only held in
  the request body and are already redacted from API responses by the route
  handler before the log entry is emitted.
- **Redaction** is available for any field via `createExportsAccessLogMiddleware`.

## Testing

Unit tests: `src/middleware/exportsAccessLog.test.ts`
Route integration tests: `src/routes/exports/schedules.test.ts`

Run with:

```bash
npm test -- exportsAccessLog
npm test -- schedules
```

Or run both together:

```bash
npm test -- --testPathPattern="exportsAccessLog|exports/schedules"
```
