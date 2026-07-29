# /api/apis Latency Histogram Metric

**Issue:** FWC26 issue #893 (b#028)  
**Metric Name:** `apis_request_duration_seconds`  
**Type:** Prometheus Histogram

## Overview

This histogram measures the end-to-end request latency for all HTTP requests to the `/api/apis` routes, including:

- `GET /api/apis` — public marketplace listings (with etag support and caching)
- `GET /api/apis/:id` — public API detail page
- `POST /api/apis` — create a new API (authenticated)
- `POST /api/apis/:id/endpoints/bulk` — bulk add endpoints to an API (authenticated)

The histogram records observations for **all outcomes** — both successful responses (2xx) and error responses (4xx, 5xx) — ensuring that latency visibility is complete even during degradation or incidents.

## Metric Labels

### Label Set

- **`route`** — Always set to `/api/apis`, identifying this as the marketplace API route
- **`method`** — HTTP verb: `GET` or `POST`
- **`status_code`** — HTTP response status as a string (e.g., `200`, `201`, `400`, `404`, `500`)

### Example Label Combinations

```
{route="/api/apis", method="GET", status_code="200"}   # Successful list/detail
{route="/api/apis", method="GET", status_code="404"}   # Non-existent API
{route="/api/apis", method="POST", status_code="201"}  # Successful creation
{route="/api/apis", method="POST", status_code="400"}  # Validation error
{route="/api/apis", method="POST", status_code="401"}  # Unauthorized (missing auth)
```

## Bucket Definitions

Buckets (in seconds):

```
0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
```

### Bucket Rationale

The `/api/apis` routes combine:

1. **Cache hits** — Typically <5ms (in-process reads for listings)
2. **Database reads** — Typically 10–100ms (API detail, DB queries)
3. **Service calls** — Potentially 50–500ms (external service latency if any)
4. **Slow/hung clients** — Occasionally >1s

**Bucket distribution:**

- **Sub-millisecond buckets** (1µs–50ms) — Fine granularity for cache-hit visibility
  - `0.001, 0.002, 0.005, 0.01, 0.025, 0.05` — Captures typical operation range
- **SLO tail buckets** (100ms–10s) — Coarse granularity for tail latency and slow clients
  - `0.1, 0.25, 0.5, 1, 2.5, 5, 10` — Tracks slow requests and incident patterns

This distribution provides:

- **High resolution** in the common case (cache-hit to simple DB query)
- **Tail visibility** for downstream service delays, client bandwidth limits, or processing bottlenecks

## Usage Examples

### PromQL Queries

**P95 latency for successful listing:**

```promql
histogram_quantile(0.95, rate(apis_request_duration_seconds_bucket{method="GET",status_code="200"}[5m]))
```

**Error rate + latency heatmap:**

```promql
# Count errors per method
sum by (method) (rate(apis_request_duration_seconds_count{status_code=~"4.."}[5m]))

# Latency percentiles per status
histogram_quantile(0.95, rate(apis_request_duration_seconds_bucket[5m])) by (status_code)
```

**Slow requests (>500ms):**

```promql
rate(apis_request_duration_seconds_bucket{le="0.5",route="/api/apis"}[5m])
```

### Grafana Dashboard

Dashboard should include:

1. **Latency heatmap** — All observations aggregated by bucket
2. **Error rate chart** — Requests with `status_code ≥ 400` over time
3. **P50, P95, P99 latency trends** — By method (GET vs POST)
4. **Slow request counter** — Requests exceeding 500ms or 1s thresholds

## Implementation Details

### Code Location

- **Histogram registration:** `src/metrics/registry.ts`
- **Recording function:** `recordApisLatency(method, statusCode, durationMs)`
- **Route instrumentation:** `src/routes/apis.ts` — middleware `recordApisTimingMiddleware`

### Middleware Behavior

The middleware wraps all `/api/apis` routes and records the full request lifecycle:

```typescript
const recordApisTimingMiddleware = (req: Request, res: Response, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    recordApisLatency(req.method, res.statusCode, duration);
  });

  next();
};
```

**Key properties:**

- **Timing scope:** From request arrival to response finish (full HTTP cycle)
- **Status code source:** `res.statusCode` (actual response sent to client)
- **Error handling:** All responses recorded, including 4xx validation errors and 5xx exceptions
- **No-op on error:** If `recordApisLatency` throws, it does not fail the HTTP request (no try/catch in middleware, but the function is simple and unlikely to fail)

### Duration Unit Conversion

- **Input:** Milliseconds (from `Date.now()` difference)
- **Storage:** Seconds (divided by 1000 before passing to histogram)
- **Prometheus output:** Seconds (histogram unit is determined at registration time)

## Testing

Tests are located in `src/__tests__/apisLatency.test.ts` and cover:

1. **Registration** — Histogram is present in the Prometheus registry with correct metadata
2. **Direct recording** — `recordApisLatency()` correctly increments buckets and counts
3. **Middleware integration** — HTTP requests to `/api/apis` routes trigger histogram observations
4. **All outcomes** — Both success (2xx) and error (4xx, 5xx) responses are recorded
5. **Label accuracy** — Observations include correct route, method, and status_code labels
6. **Duration realism** — Observed durations are measured (not hardcoded/zero)
7. **Error-path coverage** — Validation failures, 404s, and other errors are captured (critical for incident visibility)

### Running Tests

```bash
npm run test:unit -- src/__tests__/apisLatency.test.ts
npm run test:coverage
```

## Monitoring and Alerting

### Recommended Alerts

**1. High error rate on `/api/apis`:**

```promql
sum(rate(apis_request_duration_seconds_count{status_code=~"4.."}[5m])) 
  / 
sum(rate(apis_request_duration_seconds_count[5m]))
  > 0.05  # 5% error threshold
```

**2. P95 latency spike:**

```promql
histogram_quantile(0.95, rate(apis_request_duration_seconds_bucket[5m])) > 1  # > 1 second
```

**3. Slow listing queries (POST):**

```promql
rate(apis_request_duration_seconds_bucket{method="POST",le="0.5"}[5m]) > 0.1
```

## Troubleshooting

### "No data in histogram"

- Confirm `/api/apis` routes are being called (check app logs or HTTP access logs)
- Verify the middleware is applied to the router (it should be applied via `router.use()`)
- Check that the Prometheus registry is being scraped (verify `/api/metrics` endpoint returns histogram)

### "Inconsistent label values"

- All observations should use `route="/api/apis"` (hardcoded in the recording function)
- Method and status_code labels come from the HTTP request/response, so they naturally vary
- If you see unexpected labels, check for typos in the middleware or direct call sites

### "Bucket counts don't match"

- The histogram's internal bucket representation may show different values per label combination
- Use `histogram_quantile()` to derive percentiles; do not manually compute from bucket counts
- If testing, use the Prometheus registry's `.getMetricsAsJSON()` method to inspect internal state

## Related Metrics

- **`http_request_duration_seconds`** — Global HTTP latency histogram for all routes (with broader label set including `route_group`)
- **`http_route_duration_seconds`** — Per-route latency histogram (FWC26, similar pattern but without the dedicated bucket tuning for marketplace use cases)
- **`apis_listing_cache_hits_total`** — Cache hit counter for GET /api/apis (related to understanding the success path latency)
- **`apis_listing_cache_misses_total`** — Cache miss counter for GET /api/apis

## See Also

- [Prometheus Histogram Documentation](https://prometheus.io/docs/concepts/metric_types/#histogram)
- [PromQL Histogram Functions](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile)
- [Issue #893](https://github.com/callora-backend/issues/893) — FWC26 Prometheus instrumentation task
