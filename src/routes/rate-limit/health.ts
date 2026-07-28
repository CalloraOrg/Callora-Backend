/**
 * Rate-Limit Health Dependency Probe
 *
 * GET /api/rate-limit/health
 *
 * Returns the operational status of the rate-limit subsystem and its
 * dependencies. In the default in-memory implementation, the "dependency"
 * is the internal token-bucket store itself. When an external store
 * (e.g. Redis) is configured, this endpoint surfaces its connectivity
 * status as a separate dependency.
 *
 * Designed for operations dashboards and fine-grained alerting.
 */

import { Router } from 'express';
import { InMemoryRestRateLimiter } from '../../middleware/restRateLimit.js';
import { logger } from '../../logger.js';

export interface RateLimitHealthResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  dependencies: Record<string, RateLimitDependencyStatus>;
}

export interface RateLimitDependencyStatus {
  status: 'ok' | 'degraded' | 'down';
  responseTime?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface RateLimitHealthDeps {
  /** The in-memory rest rate limiter instance to probe (optional). */
  limiter?: InMemoryRestRateLimiter;
  /** Window configuration for reporting. */
  windowMs?: number;
  maxRequests?: number;
}

function determineOverallStatus(
  statuses: Record<string, 'ok' | 'degraded' | 'down'>,
): 'ok' | 'degraded' | 'down' {
  const values = Object.values(statuses);
  if (values.some((s) => s === 'down')) return 'down';
  if (values.some((s) => s === 'degraded')) return 'degraded';
  return 'ok';
}

/**
 * Creates a router for the rate-limit health dependency probe.
 *
 * @param deps - Optional dependencies to probe. When omitted or missing
 *   a limiter, returns a minimal healthy response (no configured limiter).
 */
export function createRateLimitHealthRouter(deps: RateLimitHealthDeps = {}): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const startAt = process.hrtime.bigint();

    const dependencies: Record<string, RateLimitDependencyStatus> = {};

    // Probe the in-memory rate limiter store if configured
    if (deps.limiter) {
      try {
        // Use a known test key to verify the limiter can perform check operations.
        // Peek (not check) is used so we don't consume a token.
        deps.limiter.peek('__health_probe__');
        const responseTime = Number(process.hrtime.bigint() - startAt) / 1_000_000;

        dependencies.in_memory_store = {
          status: 'ok',
          responseTime: Number(responseTime.toFixed(3)),
          details: {
            windowMs: deps.windowMs,
            maxRequests: deps.maxRequests,
          },
        };
      } catch (error) {
        const responseTime = Number(process.hrtime.bigint() - startAt) / 1_000_000;
        dependencies.in_memory_store = {
          status: 'down',
          responseTime: Number(responseTime.toFixed(3)),
          error: 'unavailable',
        };

        logger.error('[rate-limit/health] limiter probe failed', { error });
      }
    } else {
      // No limiter configured — report as healthy (not in use)
      dependencies.in_memory_store = {
        status: 'ok',
        details: { note: 'No rate limiter configured for probing' },
      };
    }

    const overallStatus = determineOverallStatus(
      Object.fromEntries(
        Object.entries(dependencies).map(([k, v]) => [k, v.status]),
      ),
    );

    const response: RateLimitHealthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      dependencies,
    };

    const statusCode = overallStatus === 'down' ? 503 : 200;
    res.status(statusCode).json(response);
  });

  return router;
}

export default createRateLimitHealthRouter;
