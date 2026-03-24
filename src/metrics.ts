import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import { performance } from 'node:perf_hooks';

// Initialize the Prometheus Registry and collect default Node.js metrics (CPU, RAM, Event Loop)
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Define the Latency Histogram
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5] // Strategic bucketing for API latency
});

// Define the Request Counter
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
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
 * Global middleware to record request metrics.
 * Safely extracts the parameterized route to prevent PII leakage and cardinality explosions.
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const endTimer = httpRequestDuration.startTimer();

  res.on('finish', () => {
    // Utilize Express's internal route matcher for parameterized paths (e.g., /api/users/:id)
    let routePattern = req.route ? req.route.path : req.path;

    // Fallback sanitizer for 404s (unmatched routes) to prevent malicious cardinality injection
    if (!req.route) {
        routePattern = routePattern
            .replace(/\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g, '/:uuid')
            .replace(/\/\d+/g, '/:id');
    }

    const fullRoute = (req.baseUrl || '') + routePattern;

    const labels = {
      method: req.method,
      route: fullRoute,
      status_code: res.statusCode.toString()
    };

    httpRequestsTotal.inc(labels);
    endTimer(labels);
  });

  next();
};

/**
 * Controller to expose the /api/metrics endpoint.
 * Protected by a Bearer token in production environments.
 */
/** Exposed for testing — reset upstream profiling metrics. */
export function resetUpstreamMetrics(): void {
  gatewayUpstreamDuration.reset();
  gatewayUpstreamRequestsTotal.reset();
}

export const metricsEndpoint = async (req: Request, res: Response) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const expectedKey = process.env.METRICS_API_KEY;

  if (isProduction && expectedKey) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${expectedKey}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
};