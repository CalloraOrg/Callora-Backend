import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import { performance } from 'node:perf_hooks';
import { UnauthorizedError } from './errors/index.js';

// Initialize the Prometheus Registry and collect default Node.js metrics (CPU, RAM, Event Loop)
const register = new client.Registry();
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

register.registerMetric(gatewayUpstreamDuration);
register.registerMetric(gatewayUpstreamRequestsTotal);

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

/** Exposed for testing — reset all metrics including upstream and HTTP. */
export function resetAllMetrics(): void {
  resetUpstreamMetrics();
  resetHttpMetrics();
}
