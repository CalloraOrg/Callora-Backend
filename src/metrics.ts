import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import { performance } from 'node:perf_hooks';
import { UnauthorizedError } from './errors/index.js';

// Initialize the Prometheus Registry and collect default Node.js metrics (CPU, RAM, Event Loop)
export const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ── Route groups ──────────────────────────────────────────────────────────────
//
// A `route_group` label is added to every HTTP metric so dashboards can slice
// latency by logical service area without exploding cardinality.
//
// Rules (evaluated in order, first match wins):
//   health   → /api/health
//   metrics  → /api/metrics
//   billing  → /api/billing/**
//   vault    → /api/vault/**
//   auth     → /api/auth/**  |  /api/keys/**
//   apis     → /api/apis/**  |  /api/developers/**  |  /api/usage
//   admin    → /api/admin/**
//   other    → everything else (404s, unknown paths)
//
// Security note: route_group is derived from the *parameterised* route pattern
// (req.route.path) or a sanitised fallback — never from raw user-supplied path
// segments — so it cannot be used to inject arbitrary label values.
// ─────────────────────────────────────────────────────────────────────────────

export type RouteGroup =
  | 'health'
  | 'metrics'
  | 'billing'
  | 'vault'
  | 'auth'
  | 'apis'
  | 'admin'
  | 'other';

/**
 * Derive a stable, low-cardinality route group from a normalised route string.
 * The input should already be the parameterised pattern (e.g. `/api/apis/:id`),
 * not a raw URL, to avoid PII leakage.
 */
export function resolveRouteGroup(route: string): RouteGroup {
  if (route === '/api/health' || route === '/api/health/') return 'health';
  if (route === '/api/metrics' || route === '/api/metrics/') return 'metrics';
  if (route.startsWith('/api/billing')) return 'billing';
  if (route.startsWith('/api/vault')) return 'vault';
  if (route.startsWith('/api/auth') || route.startsWith('/api/keys')) return 'auth';
  if (
    route.startsWith('/api/apis') ||
    route.startsWith('/api/developers') ||
    route.startsWith('/api/usage')
  ) return 'apis';
  if (route.startsWith('/api/admin')) return 'admin';
  return 'other';
}

// ── HTTP request histogram ────────────────────────────────────────────────────
//
// Buckets are intentionally tighter than the upstream histogram because these
// measure the full in-process request cycle, not external network calls.
// The `route_group` label enables per-area SLO dashboards without the
// cardinality cost of per-path histograms.
// ─────────────────────────────────────────────────────────────────────────────

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code', 'route_group'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// ── HTTP request counter ──────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'route_group'],
});

register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsTotal);

// ── Gateway upstream profiling ─────────────────────────────────────────────
//
// Metric: gateway_upstream_duration_seconds
//   Type:    Histogram
//   Labels:  api_id, method, status_code, outcome
//   Buckets: tuned for typical upstream API latencies (10 ms → 10 s)
//
// Metric: gateway_upstream_requests_total
//   Type:    Counter
//   Labels:  api_id, method, status_code, outcome
//
// Both metrics are gated behind GATEWAY_PROFILING_ENABLED=true.
// When disabled the timer helper is a cheap no-op.
// ────────────────────────────────────────────────────────────────────────────

const UPSTREAM_LABEL_NAMES = ['api_id', 'method', 'status_code', 'outcome'] as const;

const gatewayUpstreamDuration = new client.Histogram({
  name: 'gateway_upstream_duration_seconds',
  help: 'Latency of proxied requests to upstream services in seconds',
  labelNames: [...UPSTREAM_LABEL_NAMES],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const gatewayUpstreamRequestsTotal = new client.Counter({
  name: 'gateway_upstream_requests_total',
  help: 'Total proxied requests forwarded to upstream services',
  labelNames: [...UPSTREAM_LABEL_NAMES],
});

const gatewayUpstreamBreakerState = new client.Gauge({
  name: 'gateway_upstream_breaker_state',
  help: 'State of the upstream circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
  labelNames: ['api_id'],
});

register.registerMetric(gatewayUpstreamDuration);
register.registerMetric(gatewayUpstreamRequestsTotal);
register.registerMetric(gatewayUpstreamBreakerState);

/** Check whether gateway profiling hooks are active. */
export function isProfilingEnabled(): boolean {
  return process.env.GATEWAY_PROFILING_ENABLED === 'true';
}

export type UpstreamOutcome = 'success' | 'timeout' | 'error';

interface UpstreamTimer {
  /** Call once the upstream response (or error) has been received. */
  stop(statusCode: number, outcome: UpstreamOutcome): void;
}

const NOOP_TIMER: UpstreamTimer = { stop() {} };

/**
 * Begin timing an upstream request.
 *
 * Returns a timer whose `stop()` method records the observed latency and
 * increments the request counter.  When profiling is disabled the returned
 * timer is a zero-cost no-op.
 *
 * Labels intentionally avoid PII — only the API identifier and HTTP method
 * are captured, never user IDs, API keys, or request paths.
 */
export function startUpstreamTimer(apiId: string, method: string): UpstreamTimer {
  if (!isProfilingEnabled()) return NOOP_TIMER;

  const start = performance.now();

  return {
    stop(statusCode: number, outcome: UpstreamOutcome) {
      const durationSec = (performance.now() - start) / 1000;
      const labels = {
        api_id: apiId,
        method: method.toUpperCase(),
        status_code: String(statusCode),
        outcome,
      };
      gatewayUpstreamDuration.observe(labels, durationSec);
      gatewayUpstreamRequestsTotal.inc(labels);
    },
  };
}

/** Sentinel value for routes that couldn't be recognized and normalized. */
const UNKNOWN_ROUTE_SENTINEL = '_unknown';

/**
 * Normalize a route to a safe, low-cardinality template pattern.
 *
 * Rules:
 *   1. If matched via Express routing (req.route.path), use that pattern
 *      (e.g., /v1/call/:apiId instead of /v1/call/abc123)
 *   2. If unmatched (404), sanitize numeric IDs and UUIDs by replacing
 *      them with :id and :uuid placeholders
 *   3. For deeply nested or suspicious paths, return the sentinel label
 *
 * This ensures metrics cardinality stays bounded regardless of URL
 * parameter values, bot activity, or path-scanning attacks.
 */
function normalizeRouteForMetrics(
  matched: string | undefined,
  baseUrl: string | undefined,
  unmatched: string,
): string {
  // Prefer matched route pattern from Express routing
  if (matched) {
    return (baseUrl || '') + matched;
  }

  // Sanitize unmatched paths: replace UUIDs and numeric IDs with placeholders
  let sanitized = unmatched
    .replace(/\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}(?=\/|$)/g, '/:uuid')
    .replace(/\/\d+(?=\/|$)/g, '/:id');

  // Additional safety: if the path is still very long or has too many segments,
  // cap it to prevent any pathological cases
  const segments = sanitized.split('/').filter((s) => s.length > 0);
  if (segments.length > 20) {
    return UNKNOWN_ROUTE_SENTINEL;
  }

  return (baseUrl || '') + sanitized;
}

/**
 * Global middleware to record per-request latency and count metrics.
 *
 * Labels:
 *   method       – HTTP verb (GET, POST, …)
 *   route        – Parameterised route template (/api/apis/:id) or normalized
 *                  fallback for unmatched paths; uses sentinel for pathological routes
 *   status_code  – HTTP response status as a string
 *   route_group  – Logical service area (health, billing, vault, …)
 *
 * Security / cardinality notes:
 *   - Routes with matched patterns use the template (e.g., /v1/call/:apiId)
 *   - Unmatched paths (404s) are normalized by collapsing UUIDs and numeric IDs
 *   - Pathological routes (too many segments) are capped under a sentinel label
 *   - This prevents cardinality explosion from dynamic path segments, bots, or attacks
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const endTimer = httpRequestDuration.startTimer();

  res.on('finish', () => {
    // Normalize the route to a safe cardinality label
    const routePattern = normalizeRouteForMetrics(
      req.route?.path,
      req.baseUrl,
      req.path,
    );

    const routeGroup = resolveRouteGroup(routePattern);

    const labels = {
      method: req.method,
      route: routePattern,
      status_code: res.statusCode.toString(),
      route_group: routeGroup,
    };

    httpRequestsTotal.inc(labels);
    endTimer(labels);
  });

  next();
};

/**
 * GET /api/metrics
 *
 * Exposes Prometheus text-format metrics.
 * In production, requires a valid `Authorization: Bearer <METRICS_API_KEY>` header.
 *
 * Security note: the endpoint is auth-gated in production to prevent
 * internal operational data from leaking to unauthenticated callers.
 */
export const metricsEndpoint = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const isProduction = process.env.NODE_ENV === 'production';
  const expectedKey = process.env.METRICS_API_KEY;

  if (isProduction && expectedKey) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${expectedKey}`) {
      next(new UnauthorizedError());
      return;
    }
  }

  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
};

/**
 * Get aggregated P50 and P95 latency percentiles for a given API slug.
 *
 * Aggregates across all label combinations (method, status_code, outcome)
 * for that api_id. Returns null for both if no observations exist.
 *
 * This function only exposes aggregated summary statistics — never raw
 * histogram buckets, tenant identifiers, or request paths.
 */
/**
 * Extract individual metric values from the registry JSON for a given metric name.
 * Matches the pattern used in existing tests (metricsLatency.test.ts).
 */
interface MetricEntry {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

async function getUpstreamMetricValues(): Promise<MetricEntry[]> {
  const metrics = await register.getMetricsAsJSON();
  const found = metrics.find((m: any) => m.name === 'gateway_upstream_duration_seconds');
  return (found?.values ?? []) as MetricEntry[];
}

export async function getUpstreamHealth(apiSlug: string): Promise<{
  p50: number | null;
  p95: number | null;
}> {
  const values = await getUpstreamMetricValues();

  // Filter values matching this api_id
  const matchingValues = values.filter((v) => v.labels?.api_id === apiSlug);

  if (matchingValues.length === 0) {
    return { p50: null, p95: null };
  }

  // Aggregate bucket counts across all label combinations
  const bucketCounts = new Map<number, number>();
  let totalCount = 0;

  for (const v of matchingValues) {
    if (v.metricName?.endsWith('_bucket')) {
      const le = v.labels?.le;
      if (le && le !== '+Inf') {
        const bound = parseFloat(le);
        if (!isNaN(bound)) {
          bucketCounts.set(bound, (bucketCounts.get(bound) ?? 0) + v.value);
        }
      }
    } else if (v.metricName?.endsWith('_count')) {
      totalCount += v.value;
    }
  }

  if (totalCount === 0) {
    return { p50: null, p95: null };
  }

  // Sort bucket boundaries
  const sortedBounds = [...bucketCounts.keys()].sort((a, b) => a - b);

  // Build cumulative counts
  let cumulativeCount = 0;
  const cumulativeBuckets: Array<{ bound: number; cumulative: number }> = [];

  for (const bound of sortedBounds) {
    cumulativeCount += bucketCounts.get(bound) ?? 0;
    cumulativeBuckets.push({ bound, cumulative: cumulativeCount });
  }

  const p50 = computePercentile(cumulativeBuckets, totalCount, 0.5);
  const p95 = computePercentile(cumulativeBuckets, totalCount, 0.95);

  return {
    p50: p50 !== null ? Math.round(p50 * 1000) / 1000 : null,
    p95: p95 !== null ? Math.round(p95 * 1000) / 1000 : null,
  };
}

/**
 * Compute a percentile value from cumulative histogram buckets using
 * linear interpolation within the containing bucket.
 */
function computePercentile(
  cumulativeBuckets: Array<{ bound: number; cumulative: number }>,
  totalCount: number,
  percentile: number,
): number | null {
  if (totalCount === 0) return null;

  const target = totalCount * percentile;
  let prevBound = 0;
  let prevCumulative = 0;

  for (const bucket of cumulativeBuckets) {
    if (bucket.cumulative >= target) {
      const bucketWidth = bucket.bound - prevBound;
      const countInBucket = bucket.cumulative - prevCumulative;

      if (countInBucket <= 0) return bucket.bound;

      const offsetInBucket = (target - prevCumulative) / countInBucket;
      return prevBound + offsetInBucket * bucketWidth;
    }

    prevBound = bucket.bound;
    prevCumulative = bucket.cumulative;
  }

  // Beyond all buckets — return the last known bound
  return cumulativeBuckets.length > 0
    ? cumulativeBuckets[cumulativeBuckets.length - 1].bound
    : null;
}

/** Exposed for testing — reset upstream profiling metrics. */
export function resetUpstreamMetrics(): void {
  gatewayUpstreamDuration.reset();
  gatewayUpstreamRequestsTotal.reset();
}

/** Exposed for testing — reset all HTTP metrics. */
export function resetHttpMetrics(): void {
  httpRequestDuration.reset();
  httpRequestsTotal.reset();
}

// ── Listings cache hit/miss counters ─────────────────────────────────────────
//
// Metric: apis_listing_cache_hits_total
//   Type:    Counter
//   Labels:  (none — single series, low cardinality)
//   Purpose: Count how many GET /api/apis responses were served from cache.
//
// Metric: apis_listing_cache_misses_total
//   Type:    Counter
//   Labels:  (none)
//   Purpose: Count how many GET /api/apis responses required a DB read.
//
// Both counters are reset together with the other HTTP metrics in tests.
// ─────────────────────────────────────────────────────────────────────────────

const apisListingCacheHits = new client.Counter({
  name: 'apis_listing_cache_hits_total',
  help: 'Total number of GET /api/apis responses served from the in-process cache',
});

const apisListingCacheMisses = new client.Counter({
  name: 'apis_listing_cache_misses_total',
  help: 'Total number of GET /api/apis responses that required a database read (cache miss)',
});

register.registerMetric(apisListingCacheHits);
register.registerMetric(apisListingCacheMisses);

/** Increment the cache-hit counter. Called by the APIs listing route. */
export function recordCacheHit(): void {
  apisListingCacheHits.inc();
}

/** Increment the cache-miss counter. Called by the APIs listing route. */
export function recordCacheMiss(): void {
  apisListingCacheMisses.inc();
}

// ── Proxy premature-abort counter ─────────────────────────────────────────────
//
// Metric: proxy_premature_aborts_total
//   Type:    Counter
//   Labels:  (none)
//   Purpose: Count proxy responses that were aborted before the client received
//            the full body (i.e. the TCP connection closed before the HTTP
//            response finished).  A non-zero value here indicates callers that
//            were billed for calls they never fully received — investigate
//            together with the upstream duration histogram.
// ─────────────────────────────────────────────────────────────────────────────

const proxyPrematureAbortsTotal = new client.Counter({
  name: 'proxy_premature_aborts_total',
  help: 'Total number of proxy responses where the client connection closed before the response finished (premature abort)',
});

const idempotencyStoreRows = new client.Gauge({
  name: 'idempotency_store_rows',
  help: 'Current number of rows in the idempotency_store table',
});

register.registerMetric(proxyPrematureAbortsTotal);
register.registerMetric(idempotencyStoreRows);

/** Increment the premature-abort counter. Called by proxyRoutes when a response
 *  emits `close` without a preceding `finish` event. */
export function recordProxyPrematureAbort(): void {
  proxyPrematureAbortsTotal.inc();
}

/** Update the current number of active idempotency rows for monitoring. */
export function setIdempotencyStoreRows(value: number): void {
  idempotencyStoreRows.set(value);
}

/** Exposed for testing — reset all metrics including upstream and HTTP. */
export function setGatewayUpstreamBreakerState(apiId: string, state: number): void {
  gatewayUpstreamBreakerState.set({ api_id: apiId }, state);
}

/** Exposed for testing - reset all metrics including upstream and HTTP. */
export function resetAllMetrics(): void {
  resetUpstreamMetrics();
  resetHttpMetrics();
  apisListingCacheHits.reset();
  apisListingCacheMisses.reset();
  proxyPrematureAbortsTotal.reset();
  idempotencyStoreRows.reset();
  gatewayUpstreamBreakerState.reset();
  resetSlowQueryAlerterMetrics();
  resetReplicaMetrics();
}

// ── Replica routing metrics ───────────────────────────────────────────────────
//
// Metric: db_replica_queries_total
//   Type:    Counter
//   Purpose: Count read queries successfully served by a replica.
//
// Metric: db_primary_queries_total
//   Type:    Counter
//   Purpose: Count all queries routed to the primary (writes + no-replica reads
//            + fallbacks after replica failure).
//
// Metric: db_replica_fallbacks_total
//   Type:    Counter
//   Purpose: Count replica queries that failed and were retried on the primary.
//            A rising value warrants investigation of replica health.
//
// Metric: db_replica_failures_total
//   Type:    Counter
//   Purpose: Count individual replica connection/query errors (before fallback).
// ─────────────────────────────────────────────────────────────────────────────

const dbReplicaQueriesTotal = new client.Counter({
  name: 'db_replica_queries_total',
  help: 'Total number of read queries served by a PostgreSQL replica',
});

const dbPrimaryQueriesTotal = new client.Counter({
  name: 'db_primary_queries_total',
  help: 'Total number of queries routed to the primary PostgreSQL database (writes, fallbacks, and no-replica reads)',
});

const dbReplicaFallbacksTotal = new client.Counter({
  name: 'db_replica_fallbacks_total',
  help: 'Total number of replica queries that failed and were retried against the primary database',
});

const dbReplicaFailuresTotal = new client.Counter({
  name: 'db_replica_failures_total',
  help: 'Total number of individual replica connection or query errors',
});

register.registerMetric(dbReplicaQueriesTotal);
register.registerMetric(dbPrimaryQueriesTotal);
register.registerMetric(dbReplicaFallbacksTotal);
register.registerMetric(dbReplicaFailuresTotal);

/** Increment the replica query counter. Called by ReplicaPool on successful replica reads. */
export function recordReplicaQuery(): void {
  dbReplicaQueriesTotal.inc();
}

/** Increment the primary query counter. Called by ReplicaPool on primary reads and all writes. */
export function recordPrimaryQuery(): void {
  dbPrimaryQueriesTotal.inc();
}

/** Increment the fallback counter. Called by ReplicaPool when a replica error causes a primary retry. */
export function recordReplicaFallback(): void {
  dbReplicaFallbacksTotal.inc();
}

/** Increment the replica failure counter. Called by ReplicaPool on each replica-level error. */
export function recordReplicaFailure(): void {
  dbReplicaFailuresTotal.inc();
}

// ── Slow Query Alerter metrics ────────────────────────────────────────────────
//
// Metric: slow_query_alerter_runs_total
//   Type:    Counter
//   Labels:  (none)
//   Purpose: Total number of poll cycles the slow query alerter has completed.
//
// Metric: slow_query_alerter_alerts_total
//   Type:    Counter
//   Labels:  (none)
//   Purpose: Total number of webhook alerts fired.
//
// Metric: slow_query_alerter_queries_above_threshold
//   Type:    Gauge
//   Labels:  (none)
//   Purpose: Number of queries exceeding the threshold in the most recent poll.
// ─────────────────────────────────────────────────────────────────────────────

const slowQueryAlerterRunsTotal = new client.Counter({
  name: 'slow_query_alerter_runs_total',
  help: 'Total number of slow query alerter poll cycles',
});

const slowQueryAlerterAlertsTotal = new client.Counter({
  name: 'slow_query_alerter_alerts_total',
  help: 'Total number of slow query alerts fired',
});

const slowQueryAlerterQueriesAboveThreshold = new client.Gauge({
  name: 'slow_query_alerter_queries_above_threshold',
  help: 'Number of queries exceeding the threshold in the most recent poll',
});

register.registerMetric(slowQueryAlerterRunsTotal);
register.registerMetric(slowQueryAlerterAlertsTotal);
register.registerMetric(slowQueryAlerterQueriesAboveThreshold);

export function recordSlowQueryAlerterRun(): void {
  slowQueryAlerterRunsTotal.inc();
}

export function recordSlowQueryAlerterAlert(): void {
  slowQueryAlerterAlertsTotal.inc();
}

export function recordSlowQueryAlerterQueriesAboveThreshold(count: number): void {
  slowQueryAlerterQueriesAboveThreshold.set(count);
}

/** Reset slow query alerter metrics. Used in tests to isolate metric state. */
export function resetSlowQueryAlerterMetrics(): void {
  slowQueryAlerterRunsTotal.reset();
  slowQueryAlerterAlertsTotal.reset();
  slowQueryAlerterQueriesAboveThreshold.reset();
}

/** Reset all replica routing metrics. Used in tests to isolate metric state. */
export function resetReplicaMetrics(): void {
  dbReplicaQueriesTotal.reset();
  dbPrimaryQueriesTotal.reset();
  dbReplicaFallbacksTotal.reset();
  dbReplicaFailuresTotal.reset();
}
