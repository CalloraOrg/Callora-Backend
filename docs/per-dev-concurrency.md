# Per-Developer Billing Concurrency

Callora tracks how many **billing** requests are in flight for each developer at any moment.  The counts are exposed to operators through two admin endpoints, and the same signal enforces a per-developer cap that rejects excess requests with `429` rather than queueing them.

The unit of measurement is **concurrency** (requests in flight right now), not rate (requests per interval).  A developer making 1,000 fast sequential billing calls has a concurrency of 1; a developer holding 3 slow deductions open simultaneously has a concurrency of 3.  Rate limiting is handled separately — see [tiered-rate-limits.md](./tiered-rate-limits.md).

## How counts are collected

`createPerDevConcurrencyMiddleware` ([src/middleware/perDevConcurrency.ts](../src/middleware/perDevConcurrency.ts)) runs on the billing route before any billing logic.  For each authenticated request it acquires a slot on the shared `DeveloperSemaphore` and holds it until the response emits `finish` or `close`.  Client disconnects therefore release the slot just like normal completions.

Requests are bucketed by the **developer's user ID**, so counts map directly to the developer shown in the admin dashboard.

Both the middleware and the admin routes read from the same `sharedDeveloperSemaphore` singleton ([src/utils/developerSemaphore.ts](../src/utils/developerSemaphore.ts)).  This is load-bearing: if either side constructed its own instance, the endpoints would report zero forever.

Counts are per process and in memory.  Across a multi-instance deployment each instance reports only the traffic it is serving, and all counts reset on restart.  State for an idle developer is evicted after `BILLING_SEMAPHORE_TTL_MS`, so the map does not grow without bound.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_MAX_CONCURRENCY_PER_DEV` | `1` | Maximum simultaneous in-flight billing requests per developer |
| `BILLING_SEMAPHORE_TTL_MS` | `300000` | Idle time before a developer's tracking state is evicted |

The default ceiling of `1` means each developer can have at most one billing deduction in flight at any time.  Raising `BILLING_MAX_CONCURRENCY_PER_DEV` relaxes that constraint while still enforcing the chosen limit.

When a developer is at their ceiling, further requests fail fast with `429` rather than queueing, so callers get an immediate back-off signal instead of tying up connections:

```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "Concurrency limit reached. Please retry your request.",
  "requestId": "req-abc123"
}
```

A rejected request never occupies a slot, so a saturated developer cannot deepen their own backlog.

## Endpoints

Both routes live under `/api/admin` and require admin credentials — an `x-admin-api-key` header or `Authorization: Bearer <JWT>` with `role: admin`.  The admin IP allowlist applies, and each read is written to the audit log with the actor, client IP, and correlation id.

### `GET /api/admin/metrics/concurrency`

Snapshot of every developer with at least one billing request currently in flight.  Developers with zero active requests are omitted to keep the payload small.

```json
{
  "data": {
    "devCounts": { "dev_abc": 2, "dev_def": 1 },
    "totalActive": 3,
    "maxConcurrencyPerDeveloper": 1,
    "campaign": "GrantFox FWC26"
  }
}
```

An idle billing layer returns an empty `devCounts` object and a `totalActive` of `0`.

### `GET /api/admin/metrics/concurrency/:developerId`

Detail for a single developer.  Unlike the collection endpoint, this always responds even when the developer has no active requests, so polling a specific developer is stable.

```json
{
  "data": {
    "developerId": "dev_abc",
    "activeCount": 0,
    "atLimit": false,
    "maxConcurrencyPerDeveloper": 1,
    "campaign": "GrantFox FWC26"
  }
}
```

`atLimit` is `activeCount >= maxConcurrencyPerDeveloper` — the condition under which the developer's next billing request would be rejected with `429`.

Note that a trailing slash (`/api/admin/metrics/concurrency/`) resolves to the collection endpoint, not to this route with an empty `developerId`.

## Audit log events

| Event | Trigger |
|-------|---------|
| `READ_DEV_CONCURRENCY` | `GET /api/admin/metrics/concurrency` |
| `READ_DEV_CONCURRENCY_DETAIL` | `GET /api/admin/metrics/concurrency/:developerId` |

Each event records `adminActor`, `clientIp`, `userAgent`, `correlationId`, `totalActive`, and (for the detail route) `developerId`, `activeCount`, and `atLimit`.

## Operational notes

- **A developer pinned at the ceiling** usually means an upstream call is taking longer than expected.  Check the billing deduction latency dashboard and the Soroban RPC circuit-breaker state before raising the limit.
- **`totalActive` persistently high** while throughput is flat suggests requests are not completing — look for upstream timeouts or semaphore leaks in the application log.
- **Counts that stay at zero under real traffic** mean the middleware is no longer using the shared semaphore instance (`sharedDeveloperSemaphore`).  This can happen if a route passes custom `maxConcurrent` or `ttlMs` options to `createPerDevConcurrencyMiddleware`, causing it to create a dedicated private instance.  Ensure default (no options) or explicit `semaphore` injection is used for the routes you want to observe.
- **Per-process counts** — in a horizontally scaled deployment, each pod reports its own traffic only.  Aggregate across instances for a cluster-wide view.

## Related

- [docs/per-key-concurrency.md](./per-key-concurrency.md) — per-API-key gateway concurrency (same pattern, different identity dimension)
- [docs/tiered-rate-limits.md](./tiered-rate-limits.md) — token-bucket rate limiting (different from concurrency)
- [src/middleware/perDevConcurrency.ts](../src/middleware/perDevConcurrency.ts)
- [src/utils/developerSemaphore.ts](../src/utils/developerSemaphore.ts)
- [src/routes/admin/metrics.ts](../src/routes/admin/metrics.ts)
