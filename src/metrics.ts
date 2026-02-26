import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';

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