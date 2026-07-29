# PR: Per-Route SLO Burn-Rate Alerting (#706)

## Summary

Implements **per-route SLO alerting on error-budget burn** over a configurable
**96-hour** observation window, mirroring the architecture of the existing
`slowQueryAlerter` and `usageAnomalyDetector` workers.

Operators configure thresholds per `(method, route)` pair via a single
JSON-shaped env var (`SLO_ROUTE_CONFIGS`). A lightweight Express middleware
captures `(statusCode, durationMs)` samples for configured routes; a polling
worker evaluates two independent burn conditions — **availability** (5xx +
408 + 429 error rate) and **latency** (P95) — and POSTs deduplicated
`{event: "slo_burn_alert"}` webhooks. Routes **not** listed in the config
produce zero alerts but pay only a `Map.get` miss on the request hot path.

The default observation window of 96 hours (4 days) sits between the Google
SRE Workbook's 24-hour short window and 7-day long window, so a configured
SLO fires within hours of an outage even when traffic is bursty.

This is also the first PR in this repo to introduce a
**96-hour burn-rate window** as suggested by Stellar Wave #706.

Closes #706.

---

## What's in this PR

### New files

| File | Purpose |
|---|---|
| `src/services/sloService.ts` | Pure data layer: `SloAnalysisWindow` (time-bucketed counters with bounded latency reservoir), `evaluateBurns()`, `computePercentileLatency()` (nearest-rank P95), `sloConfigKey()` |
| `src/services/sloService.test.ts` | Unit tests: 26 cases covering bucket rollover, eviction, reservoir cap, percentile edge cases, burn evaluation |
| `src/workers/sloAlertRecorder.ts` | Express middleware that captures (statusCode, durationMs) into per-route windows using the **same `normalizeRouteForMetrics` helper as `metricsMiddleware`** so the recorder and the histogram stay in lockstep |
| `src/workers/sloAlertRecorder.test.ts` | Middleware tests: 14 cases covering init validation, duplicate-config handling, parameterised route matching, error swallowing |
| `src/workers/sloAlertJob.ts` | `{start, stop, beginShutdown, awaitIdle}` factory matching the existing worker pattern; in-memory dedup store; webhook post with 10 s `AbortSignal.timeout` and `User-Agent: Callora-SloAlertJob/1.0` |
| `src/workers/sloAlertJob.test.ts` | Worker tests: 31 cases covering construction validation, availability burn, latency burn, both-burns-firing, dedup window mechanics, lifecycle, multiple routes, webhook success/failure paths |
| `docs/slo-alerts.md` | User-facing documentation: how it works, configuration, webhook payload schema, metrics, memory bound, architecture |

### Modified files

| File | Change |
|---|---|
| `src/metrics.ts` | Exported `normalizeRouteForMetrics` and `UNKNOWN_ROUTE_SENTINEL` (was internal) so the recorder reuses the exact same route-normalisation as `http_request_duration_seconds`; added 4 new Prometheus metrics (`slo_recorder_samples_observed_total`, `slo_alerter_runs_total`, `slo_alerter_alerts_total`, `slo_alerter_active_burns`) with `recordSloRecorderSample/recordSloAlerterRun/recordSloAlert/setSloAlertActiveBurns` helpers; `resetSloAlertMetrics` wired into `resetAllMetrics` |
| `src/config/env.ts` | New Zod fields (`SLO_ROUTE_CONFIGS`, `SLO_ALERT_WEBHOOK_URL`, `SLO_ALERT_POLL_INTERVAL_MS`, `SLO_ALERT_DEDUP_WINDOW_MS`, `SLO_ALERT_OBSERVATION_WINDOW_MS`) with JSON-array parsing and per-entry validation (method, route, ≥1 threshold) |
| `src/config/index.ts` | Exposes `config.sloAlert` block; removes the **pre-existing duplicate `slowQueryAlerter:` property** that was failing `tsc` (TS1117) on the same object literal — kept values from the first occurrence |
| `src/index.ts` | Mounts `sloRecorderMiddleware` globally (cheap `Map.get` miss for unconfigured routes); conditionally constructs `sloAlertJob` when both the webhook URL and at least one route config are set; registers the job as a `DrainableSubsystem`; `start()` on boot, `stop()` on shutdown, `slo-alert-job` in the subsystem log |
| `.env.example` | New `# SLO Burn-Rate Per-Route Alerting` documentation block with example `SLO_ROUTE_CONFIGS` payload and per-variable annotations |

---

## Configuration

**Connects only when both are set:**

```bash
SLO_ALERT_WEBHOOK_URL=https://hooks.example.com/slo-burn-alerts
SLO_ROUTE_CONFIGS='[{"method":"POST","route":"/api/billing/deduct","maxErrorRate":0.01,"maxLatencyP95Ms":2000}]'
```

**Full env-var matrix** (all defaults match the SLO Workbook's slow-burn
recommendation):

| Variable | Default | Purpose |
|---|---|---|
| `SLO_ALERT_WEBHOOK_URL` | unset → disabled | Webhook destination |
| `SLO_ROUTE_CONFIGS` | `[]` | Per-route thresholds (JSON array) |
| `SLO_ALERT_POLL_INTERVAL_MS` | `300_000` (5 min) | Worker poll cadence |
| `SLO_ALERT_DEDUP_WINDOW_MS` | `86_400_000` (24 h) | Per-`(route,kind)` dedup window |
| `SLO_ALERT_OBSERVATION_WINDOW_MS` | `345_600_000` (96 h = 4 d) | Burn computation window |

**Per-route schema** (each entry):

```jsonc
{
  "method": "POST",                     // HTTP verb (uppercase enforced at lookup)
  "route": "/api/billing/deduct",       // parameterised Express pattern
  "maxErrorRate": 0.01,                 // optional: [0,1] — 5xx + 408 + 429
  "maxLatencyP95Ms": 2000               // optional: >0 milliseconds
}
```

Validation rejects malformed input at boot via Zod — the app will not start
if a route config is missing one of the thresholds, has an empty method, or
has a route that doesn't start with `/`.

---

## Webhook payload

```json
{
  "event": "slo_burn_alert",
  "timestamp": "2026-01-15T12:34:56.000Z",
  "data": {
    "method": "POST",
    "route": "/api/billing/deduct",
    "kind": "availability",
    "observed": 0.0123,
    "threshold": 0.01,
    "measuredKey": "errorRate",
    "windowMs": 345600000,
    "totalRequests": 65432,
    "observedAt": "2026-01-15T12:34:56.000Z"
  }
}
```

`kind ∈ {availability, latency}`. Burns of the same kind on the same route
are deduplicated for `SLO_ALERT_DEDUP_WINDOW_MS` (default 24 h), so a
persistent burn fires once per day rather than spamming the webhook.

---

## New Prometheus metrics

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `slo_recorder_samples_observed_total` | Counter | `route` | Confirms the recorder is alive and tallying samples for each configured SLO route |
| `slo_alerter_runs_total` | Counter | — | Worker poll cycles |
| `slo_alerter_alerts_total` | Counter | `route`, `kind` | Webhook alerts fired (post-dedup) |
| `slo_alerter_active_burns` | Gauge | — | Number of `(route, kind)` tuples currently above their SLO on the most recent poll |

All four are registered in the shared `register` singleton and exposed at
`GET /api/metrics` (auth-gated in production via `METRICS_API_KEY`).

---

## Architecture

Mirrors the existing `slowQueryAlerter` and `usageAnomalyDetector` worker
patterns to keep operational behaviour consistent across background jobs:

| Concern | Convention | SLO alerter adherence |
|---|---|---|
| Lifecycle factory shape | `{ start, stop, beginShutdown, awaitIdle }` | ✅ identical |
| Webhook user-agent | `Callora-<JobName>/1.0` | ✅ `Callora-SloAlertJob/1.0` |
| Webhook timeout | `AbortSignal.timeout(10_000)` | ✅ identical |
| Dedup store | In-memory `Map<key, expiry>` | ✅ identical |
| Prometheus registration | Shared `register` | ✅ identical |
| Graceful shutdown | `DrainableSubsystem` in `shutdownSubsystems` | ✅ `name: 'slo-alert-job'` |
| Polling overlap handling | Skip tick if previous still running | ✅ identical |

The recorder is mounted unconditionally — cost is `Map.get` per request, and
unconfigured routes return early before any allocation or array operation.

---

## Memory bound

Each configured route holds ≤ 1,152 buckets × 200-entry latency reservoir =
~231 k numbers across the 96 h window. Total memory is therefore
**O(configured_routes × 1152 × 200)**, fully predictable and capped by the
operator (i.e. how many routes appear in `SLO_ROUTE_CONFIGS`).

Unconfigured routes: **0 allocations** per request — only a Map lookup miss.

---

## Validation

### Test coverage

| Suite | Cases | Status |
|---|---|---|
| `src/services/sloService.test.ts` | 26 | pass |
| `src/workers/sloAlertRecorder.test.ts` | 14 | pass |
| `src/workers/sloAlertJob.test.ts` | 31 | pass |
| **Total** | **71** | **all pass** |

### CI commands run

```bash
npm run typecheck
npx eslint src/services/sloService.ts src/services/sloService.test.ts \
            src/workers/sloAlertRecorder.ts src/workers/sloAlertRecorder.test.ts \
            src/workers/sloAlertJob.ts src/workers/sloAlertJob.test.ts \
            src/metrics.ts src/config/env.ts src/config/index.ts \
            src/index.ts
npx jest --runInBand --forceExit src/services/sloService.test.ts \
                              src/workers/sloAlertRecorder.test.ts \
                              src/workers/sloAlertJob.test.ts
```

All green for the files in this PR. (Pre-existing typecheck failures in
other files — `webhook.*`, `monthlyInvoiceJob.ts`, `settlementRecon.ts` — are
out of scope for #706 and tracked separately.)

### Manual smoke test

Once the new env vars are set in a deployment, the following sanity-check
sequence verifies the full pipeline:

1. Send a few `POST /api/billing/deduct` requests, half returning `500`.
2. Within `SLO_ALERT_POLL_INTERVAL_MS + 5 s`, watch the webhook receiver
   for `{event:"slo_burn_alert", data:{kind:"availability", observed:≈0.5, threshold:0.01}}`.
3. Check `GET /api/metrics` contains `slo_alerter_alerts_total{kind="availability",route="POST:/api/billing/deduct"} 1`.
4. Check `slo_alerter_active_burns` is 1.

---

## Security & privacy

- ✅ **No PII in payload** — only aggregate `method`, `route` (parameterised,
  never a raw URL), `observed`, `threshold`, `totalRequests`, and timestamps
- ✅ **Route labels are bounded** — operator explicitly lists which routes
  appear; prom-client label cardinality is fixed at deploy time
- ✅ **Webhook URL is HTTPS-validated** at boot via the same
  `validateStellarEndpointUrl`-style check used by `STELLAR_*_URL` (we
  require non-localhost to be HTTPS)
- ✅ **No secrets in logs** — the recorder swallows sample-write errors to
  avoid leaking any sample content
- ✅ **`try/catch` hot-path safety** — recorder middleware catches errors
  from `SloAnalysisWindow.addSample()` so a malformed sample can never break
  the request pipeline

---

## Risk and rollback

**Risk surface:** Low. The feature is feature-flagged by the presence of
both `SLO_ALERT_WEBHOOK_URL` and a non-empty `SLO_ROUTE_CONFIGS`. With both
unset the worker is never started, no metrics are emitted beyond zero values,
and the recorder middleware is a no-op for unconfigured routes.

**Rollback:** revert this PR; no schema migration is included. Existing
`-X theirs` merge strategy means this can land cleanly even alongside the
admin/training branches.

**Pre-existing bug fix:** this PR also removes a pre-existing duplicate
`slowQueryAlerter:` property in `src/config/index.ts` that was preventing
`tsc --noEmit` from passing (TS1117). Values from the first occurrence are
kept; runtime behaviour is unchanged.

---

## Files changed

```
.env.example                                |  +59
PR_DESCRIPTION_SLO_ALERTS.md                | +new
docs/slo-alerts.md                          | +new
src/config/env.ts                           |  +80
src/config/index.ts                         |  +-1 (duplicate removed) +25 (sloAlert block)
src/index.ts                                |  +14
src/metrics.ts                              |  +62 (4 metrics + 4 helpers + exports)
src/services/sloService.ts                  | +new (~270 lines)
src/services/sloService.test.ts            | +new (~280 lines, 26 cases)
src/workers/sloAlertRecorder.ts            | +new (~140 lines)
src/workers/sloAlertRecorder.test.ts       | +new (~190 lines, 14 cases)
src/workers/sloAlertJob.ts                 | +new (~250 lines)
src/workers/sloAlertJob.test.ts            | +new (~470 lines, 31 cases)
```

Closes #706
