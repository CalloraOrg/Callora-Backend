# Billing Access Logs

Structured JSON access logs for all billing endpoints, emitted with
correlation IDs for end-to-end request tracing.

## Overview

Every request that flows through the `/api/billing/*` router is wrapped by
`src/middleware/billingAccessLog.ts`.  On response completion the middleware
emits a single structured log entry on the `billing` Pino channel.

This is distinct from the global access log (`src/middleware/accessLog.ts`),
which samples all requests.  Billing logs are **always emitted** (100 %)
because billing operations are high-value and must be auditable.

## Log Fields

| Field              | Type     | Description                                                        |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `correlationId`    | string   | Correlation token from `x-correlation-id` or `x-request-id` header |
| `requestId`        | string   | Sanitised `x-request-id` header or generated UUID v4               |
| `method`           | string   | HTTP method (`POST`, `GET`, …)                                     |
| `path`             | string   | Request path (e.g. `/billing/deduct`)                              |
| `status`           | number   | HTTP response status code                                          |
| `statusCode`       | number   | Alias for `status` (kept for compatibility with access-log format) |
| `ms`               | number   | Request duration in milliseconds (3 decimal places)                |
| `durationMs`       | number   | Alias for `ms`                                                     |
| `responseBytes`    | number   | Size of the HTTP response body in bytes                            |
| `userId`           | string?  | Authenticated developer/user ID (from `res.locals.authenticatedUser`) |
| `actor`            | string?  | Alias for `userId` — surfaced separately for audit tooling queries |
| `clientIp`         | string?  | Client IP address (respects `TRUST_PROXY_HEADERS`)                 |
| `apiId`            | string?  | Billing target API ID (from request body)                          |
| `endpointId`       | string?  | Billing target endpoint ID (from request body)                     |
| `apiKeyId`         | string?  | Billing API key ID (from request body)                             |
| `amountUsdc`       | string?  | Deducted amount in USDC (from request body)                        |
| `billingRequestId` | string?  | Client-supplied billing request ID (from request body)             |

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

## Redaction

Sensitive fields can be redacted by passing `redactFields` to the middleware
factory:

```typescript
createBillingAccessLogMiddleware({
  redactFields: ['amountUsdc', 'apiKeyId'],
});
```

Redacted values are replaced with `[REDACTED]`.  Field matching is
case-insensitive.

## Wiring

The middleware is mounted at the top of the billing router in
`src/routes/billing.ts`:

```typescript
import { billingAccessLogMiddleware } from "../middleware/billingAccessLog.js";

const router = Router();
router.use(billingAccessLogMiddleware);
```

This ensures **every** billing sub-route (credits, disputes, deduct,
fee-abstraction, bulk-deduct) is covered.

## Configuration

| Environment variable         | Default | Description                              |
| ---------------------------- | ------- | ---------------------------------------- |
| `TRUST_PROXY_HEADERS`        | `false` | When `true`, honours `X-Forwarded-For` etc. for client IP extraction |

## Security

- **No raw user input** is logged without sanitisation.
- **Header injection** is prevented by stripping control characters from
  correlation/request IDs.
- **PII** is not included in log payloads — only IDs and amounts.
- **Redaction** is available for any field that should not appear in logs.

## Testing

Unit tests: `src/middleware/billingAccessLog.test.ts`
Integration tests: `src/middleware/billingAccessLog.integration.test.ts`

Run with:

```bash
npm test -- billingAccessLog
```
