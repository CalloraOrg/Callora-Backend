# Plans Endpoint — Per-Request Timeout

## Overview

`GET /api/plans` (and all sub-routes under `/api/plans`) are protected by a
**per-request timeout middleware** that enforces a maximum wall-clock deadline.
This prevents slow or hung handlers from exhausting server resources.

## Configuration

The timeout is configured when the plans router is created:

```ts
import { createPlansRouter } from "./routes/plans.js";

// Default: 10 000 ms (10 seconds)
router.use("/plans", createPlansRouter());

// Custom timeout
router.use("/plans", createPlansRouter(5_000));
```

| Parameter  | Type   | Default | Description                                      |
|------------|--------|---------|--------------------------------------------------|
| `timeoutMs`| number | `10000` | Maximum request duration in milliseconds. A value ≤ 0 disables the timeout. |

## Behaviour

1. **Deadline enforcement** — When the configured deadline elapses before the
   handler sends a response, the middleware:
   - Calls `controller.abort()` on a per-request `AbortController`, signalling
     any in-flight I/O (database queries, `fetch`, etc.) to cancel cooperatively.
   - Sends an HTTP **504 Gateway Timeout** response.

2. **Cooperative cancellation** — The `AbortSignal` is exposed on `req.abortSignal`
   and `req.signal`. Handlers that perform async work should check
   `signal.aborted` and pass the signal to APIs that support it (e.g.
   `fetch(url, { signal })`, `pg` query cancellation).

3. **No duplicate responses** — If the handler attempts to respond after the
   timeout has already sent a 504, the late response is silently dropped
   (`res.headersSent` guard).

4. **Timer cleanup** — The deadline timer is cleared when the response finishes
   or the connection closes, preventing resource leaks.

## Error Response

When the timeout fires, the response uses the canonical error envelope:

```json
{
  "success": false,
  "error": {
    "code": "GATEWAY_TIMEOUT",
    "message": "Request timed out after 10000ms"
  },
  "requestId": "req_abc123",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

| Field       | Description                                                        |
|-------------|--------------------------------------------------------------------|
| `success`   | Always `false`.                                                    |
| `error.code`| Stable machine-readable code: `GATEWAY_TIMEOUT`.                   |
| `error.message`| Human-readable message including the configured timeout value. |
| `requestId` | Correlation ID from the `x-request-id` header or `req.id`.        |
| `timestamp` | ISO-8601 timestamp of the response.                               |

## Endpoints

| Method | Path         | Description                                           |
|--------|--------------|-------------------------------------------------------|
| GET    | `/api/plans` | List all available subscription plans.                |
| GET    | `/api/plans/:id` | Get a single plan by ID.                          |
| GET    | `/api/plans/slow` | Simulates a slow handler (3s delay) for testing timeout behaviour. |

## Disabling the Timeout

Pass a value ≤ 0 to disable the timeout entirely (useful in tests):

```ts
createPlansRouter(0);   // disabled
createPlansRouter(-1);  // disabled
```

When disabled, the middleware still attaches an `AbortController` to `req` for
API consistency, but no timer is scheduled.
