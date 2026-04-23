import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import { performance } from 'node:perf_hooks';

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

/**
 * Global middleware to record per-request latency and count metrics.
 *
 * Labels:
 *   method       – HTTP verb (GET, POST, …)
 *   route        – Parameterised route pattern (/api/apis/:id) or sanitised
 *                  fallback for unmatched paths.  Never contains raw user input.
 *   status_code  – HTTP response status as a string.
 *   route_group  – Logical service area (health, billing, vault, …).
 *
 * Security / cardinality notes:
 *   - `route` uses req.route.path (Express's matched pattern) when available,
 *     so dynamic segments like IDs are collapsed to `:id` / `:uuid`.
 *   - For 404s the path is sanitised by replacing numeric and UUID segments
 *     before being stored, preventing cardinality explosions from bots or
 *     path-scanning attacks.
 *   - `route_group` is derived from the sanitised route, not raw user input.
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const endTimer = httpRequestDuration.startTimer();

  res.on('finish', () => {
    // Use Express's matched route pattern when available (collapses :id, :uuid, etc.)
    let routePattern = req.route ? req.route.path : req.path;

    // Sanitise unmatched paths (404s) to prevent cardinality injection
    if (!req.route) {
      routePattern = routePattern
        .replace(/\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g, '/:uuid')
        .replace(/\/\d+/g, '/:id');
    }

    const fullRoute = (req.baseUrl || '') + routePattern;
    const routeGroup = resolveRouteGroup(fullRoute);

    const labels = {
      method: req.method,
      route: fullRoute,
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
export const metricsEndpoint = async (req: Request, res: Response): Promise<void> => {
  const isProduction = process.env.NODE_ENV === 'production';
  const expectedKey = process.env.METRICS_API_KEY;

  if (isProduction && expectedKey) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${expectedKey}`) {
      res.status(401).json({ error: 'Unauthorized' });
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
