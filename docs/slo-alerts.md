# SLO Burn-Rate Per-Route Alerting

A background worker that polls a small in-memory window of per-route
request samples and fires a deduplicated webhook whenever a configured
`(method, route)` exceeds its burn threshold. Implementation lives in
`src/services/sloService.ts`, `src/workers/sloAlertRecorder.ts`,
`src/workers/sloAlertJob.ts`.

## How it works

```
                  ┌──────────────────────────────────────────────┐
HTTP request ───► │ sloRecorderMiddleware  (every route)         │
                  │   ↳ look up window for (method, route)       │
                  │   ↳ if configured: append sample             │
                  └────────────────┬─────────────────────────────┘
                                   │ (in-memory)
                                   ▼
                  ┌──────────────────────────────────────────────┐
                  │ SloAnalysisWindow  (one per configured route) │
                  │   ↳ 5-minute time buckets (~1,152 × 96 h)     │
                  │   ↳ bounded latency reservoir per bucket     │
                  │   ↳ evict buckests outside the window        │
                  └────────────────┬─────────────────────────────┘
                                   │
        setInterval(SLO_ALERT_POLL_INTERVAL_MS) │ every tick
                                   ▼
                  ┌──────────────────────────────────────────────┐
                  │ sloAlertJob                                   │
                  │   ↳ getMetrics() → error rate + P95 latency   │
                  │   ↳ evaluateBurns() → list of (route,kinds)  │
                  │   ↳ dedup window per (route, kind)           │
                  │   ↳ POST JSON to webhook when new burn        │
                  └──────────────────────────────────────────────┘
```

1. The **recorder** middleware (`sloRecorderMiddleware`) runs on every
   request. It looks up a `SloAnalysisWindow` keyed by
   `sloConfigKey(method, route)` and, when found, appends the
   `(statusCode, durationMs)` sample along with the current timestamp.
   Unconfigured routes pay only the cost of a `Map.get` lookup.
2. Each `SloAnalysisWindow` is a chronologically-ordered array of
   5-minute time buckets. Buckets expire automatically once their
   timestamp window is fully outside the configured observation window.
3. The **alerter** polls on `SLO_ALERT_POLL_INTERVAL_MS` (default 5 min).
   For every configured route it asks the window for `(errorRate,
   p95LatencyMs, totalRequests)` over the trailing observation window
   (`SLO_ALERT_OBSERVATION_WINDOW_MS`, default 96 h).
4. `evaluateBurns` returns a burn condition for each kind whose
   observed value exceeds the configured threshold. The alerter
   dedups on `(route, kind)` for `SLO_ALERT_DEDUP_WINDOW_MS` (default
   24 h) so a persistent burn fires once per day, not on every tick.
5. New (route, kind) burns POST a JSON envelope to
   `SLO_ALERT_WEBHOOK_URL` with the 10 s `AbortSignal.timeout` guard
   used elsewhere by the project.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SLO_ALERT_WEBHOOK_URL` | — | Webhook to POST `slo_burn_alert` envelopes. When unset (or empty) the job is not started. The recorder remains mounted regardless. |
| `SLO_ROUTE_CONFIGS` | `[]` | JSON array of per-route SLO entries. Each entry MUST define at least one of `maxErrorRate` or `maxLatencyP95Ms`. |
| `SLO_ALERT_POLL_INTERVAL_MS` | `300000` (5 min) | Worker poll cadence. |
| `SLO_ALERT_DEDUP_WINDOW_MS` | `86400000` (24 h) | Per-(route, kind) dedup window. |
| `SLO_ALERT_OBSERVATION_WINDOW_MS` | `345600000` (96 h = 4 days) | Trailing burn observation window. |

### SLO config schema

Each entry in `SLO_ROUTE_CONFIGS` is:

```jsonc
{
  "method": "POST",            // HTTP verb, upper-cased
  "route": "/api/billing/deduct", // parameterised Express route pattern
  "maxErrorRate": 0.01,        // optional: [0,1] 5xx + 408 + 429 ratio
  "maxLatencyP95Ms": 2000      // optional: positive milliseconds
}
```

Validation rules enforced by the Zod schema (`src/config/env.ts`):

- `method` and `route` must be non-empty strings
- `route` must start with `/`
- `maxErrorRate` (when present) must lie in `[0, 1]`
- `maxLatencyP95Ms` (when present) must be positive
- Each entry must define at least one threshold — empty entries are rejected

Routes NOT listed in `SLO_ROUTE_CONFIGS` are never alerted on. The
recorder is mounted for every route but is cheap on unconfigured
routes (single `Map.get` returning `undefined`).

### Route label matching

Routes must use the parameterised Express pattern, identical to the
one emitted by the `http_request_duration_seconds` histogram. Common
examples:

| Express route | Config `route` value |
|---|---|
| `POST /api/billing/deduct` | `/api/billing/deduct` |
| `GET /api/apis/:id` | `/api/apis/:id` |
| `GET /v1/call/:apiId` | `/v1/call/:apiId` |

The recorder and the HTTP histogram both call
`normalizeRouteForMetrics(req.route?.path, req.baseUrl, req.path)` so
their labels stay in lockstep for any given request.

## Webhook payload

```json
{
  "event": "slo_burn_alert",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "data": {
    "method": "POST",
    "route": "/api/billing/deduct",
    "kind": "availability",
    "observed": 0.0123,
    "threshold": 0.01,
    "measuredKey": "errorRate",
    "windowMs": 345600000,
    "totalRequests": 65432,
    "observedAt": "2026-01-01T00:00:00.000Z"
  }
}
```

Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Callora-SloAlertJob/1.0` |

`kind` is one of:

- `availability` — `measuredKey=errorRate` (fraction in `[0, 1]`)
- `latency`      — `measuredKey=p95LatencyMs` (milliseconds)

## Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `slo_recorder_samples_observed_total` | Counter | `route` | Samples observed per configured route — confirms the recorder is alive |
| `slo_alerter_runs_total` | Counter | — | Worker poll cycles |
| `slo_alerter_alerts_total` | Counter | `route`, `kind` | Webhook alerts fired (post-dedup) |
| `slo_alerter_active_burns` | Gauge | — | Number of (route, kind) tuples currently above their SLO |

All metrics live in the shared `src/metrics.ts` registry and are
exposed at `GET /api/metrics` (auth-gated in production).

## Memory bound

Each configured route holds at most `1152 × 200 = ~231k` numbers
across the 96 h window (1,152 buckets × up to 200-entry latency
reservoir). The recorder returns a no-op for routes with no
configured SLO so memory is bounded by the number of *configured*
routes rather than by the cardinality of HTTP traffic.

## Architecture

The worker follows the same `{ start, stop, beginShutdown, awaitIdle }`
factory pattern used by other background jobs (`slowQueryAlerter`,
`anomalyDetector`, `revenueLedgerIndexer`). It registers as a
`DrainableSubsystem` in `src/index.ts` so graceful shutdown drains
the in-flight tick before closing the HTTP server.

## Graceful shutdown

The alerter is added to `shutdownSubsystems` in `src/index.ts` as
`slo-alert-job`. On SIGTERM/SIGINT:

1. `beginShutdown` clears the timer and refuses new ticks.
2. `awaitIdle` waits for the currently running tick to finish posting
   its webhook.
3. `stop` is then called from `closeAllDataResources` for belt-and-
   braces idempotency.

## Testing

```bash
npx jest src/services/sloService.test.ts
npx jest src/workers/sloAlertRecorder.test.ts
npx jest src/workers/sloAlertJob.test.ts
```

The recorder and worker tests follow the same fake-timer / mock-`fetch`
patterns as `src/workers/slowQueryAlerter.test.ts`.

## Error Handling

- Poll failures are logged at `error` level and do not crash the worker.
- Webhook POST failures are logged at `error` level; the next tick
  will re-attempt once the dedup window has expired.
- Recorder middleware swallows any exception from the analysis window
  so a malformed sample can never break the request pipeline.

## Security / privacy

- Only parameterised route patterns are recorded — raw URL paths, user
  IDs, and API keys are never copied into the analysis window.
- The webhook payload contains aggregate counts and rates only — never
  per-request data.
- `SLO_ALERT_WEBHOOK_URL` must be HTTPS in production unless the
  hostname is localhost (enforced by URL validation).
