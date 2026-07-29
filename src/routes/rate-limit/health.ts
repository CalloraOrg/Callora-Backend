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
 * ## Circuit Breaker — per-endpoint isolation (issue #904)
 *
 * Every downstream probe call is wrapped with a per-endpoint circuit breaker
 * drawn from a shared `BreakerRegistry`. The breaker key matches the dependency
 * name so each dependency is isolated:
 *
 *   - `rate-limit/health/in_memory_store`
 *
 * When the breaker is **OPEN** the route fast-fails the entire request with
 * `HTTP 503 Service Unavailable` (using `ServiceUnavailableError` so the
 * standard error envelope is returned). No downstream probe is attempted,
 * preventing resource exhaustion during outages.
 *
 * The breaker resets automatically after the configured cooldown period
 * (`circuitBreakerCooldownMs`). Threshold and cooldown are configurable via
 * `RateLimitHealthDeps` so tests can drive edge-cases without relying on real
 * timers.
 *
 * Designed for operations dashboards and fine-grained alerting.
 */

import { Router } from 'express';
import { InMemoryRestRateLimiter } from '../../middleware/restRateLimit.js';
import { logger } from '../../logger.js';
import {
  BreakerRegistry,
  getDefaultBreakerRegistry,
  withCircuitBreaker,
  type CircuitBreakerConfig,
} from '../../lib/circuitBreaker.js';
import { CircuitBreakerOpenError } from '../../lib/errors.js';
import { ServiceUnavailableError } from '../../errors/index.js';

// ── Endpoint slugs ──────────────────────────────────────────────────────────
// Stable identifiers used as BreakerRegistry keys AND Prometheus labels.
// Changing these is a breaking observability change; prefer additive new slugs.
export const RATE_LIMIT_HEALTH_BREAKER_SLUG = 'rate-limit/health/in_memory_store';

// ── Types ───────────────────────────────────────────────────────────────────

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
  /**
   * BreakerRegistry to use for per-endpoint circuit breakers.
   * Defaults to the process-wide singleton so breaker state persists across requests.
   * Pass a fresh registry in tests to keep test cases isolated.
   */
  breakerRegistry?: BreakerRegistry;
  /**
   * Circuit-breaker configuration applied when the breaker for an endpoint is
   * first created. Subsequent requests reuse the already-created breaker.
   */
  circuitBreakerConfig?: CircuitBreakerConfig;
}

// ── Helper ───────────────────────────────────────────────────────────────────

function determineOverallStatus(
  statuses: Record<string, 'ok' | 'degraded' | 'down'>,
): 'ok' | 'degraded' | 'down' {
  const values = Object.values(statuses);
  if (values.some((s) => s === 'down')) return 'down';
  if (values.some((s) => s === 'degraded')) return 'degraded';
  return 'ok';
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates a router for the rate-limit health dependency probe.
 *
 * Each downstream probe is wrapped with a per-endpoint circuit breaker.
 * When any breaker is OPEN the entire request fast-fails with HTTP 503
 * via `ServiceUnavailableError`.
 *
 * @param deps - Optional dependencies to probe. When omitted or missing
 *   a limiter, returns a minimal healthy response (no configured limiter).
 */
export function createRateLimitHealthRouter(deps: RateLimitHealthDeps = {}): Router {
  const router = Router();

  // Resolve breaker registry — fall back to global singleton.
  const registry = deps.breakerRegistry ?? getDefaultBreakerRegistry();
  const cbConfig = deps.circuitBreakerConfig;

  router.get('/', async (req, res, next) => {
    // Structured correlation ID for log correlation across request lifecycle
    const correlationId =
      (req.headers['x-request-id'] as string | undefined) ??
      (req.headers['x-correlation-id'] as string | undefined) ??
      (req as unknown as { id?: string }).id ??
      'unknown';

    const startAt = process.hrtime.bigint();
    const dependencies: Record<string, RateLimitDependencyStatus> = {};

    // ── Probe the in-memory rate-limiter store ─────────────────────────────
    try {
      if (deps.limiter) {
        /**
         * Wrap the limiter peek() call in the per-endpoint circuit breaker.
         * A `CircuitBreakerOpenError` means the store was recently unavailable
         * and we fast-fail to avoid hammering a degraded dependency.
         */
        await withCircuitBreaker(
          registry,
          RATE_LIMIT_HEALTH_BREAKER_SLUG,
          async () => {
            // Use peek (not check) so we do not consume a rate-limit token.
            // Throws on any unexpected limiter error.
            deps.limiter!.peek('__health_probe__');
          },
          cbConfig,
        );

        const responseTime = Number(process.hrtime.bigint() - startAt) / 1_000_000;
        dependencies.in_memory_store = {
          status: 'ok',
          responseTime: Number(responseTime.toFixed(3)),
          details: {
            windowMs: deps.windowMs,
            maxRequests: deps.maxRequests,
          },
        };
      } else {
        // No limiter configured — report as healthy (not in use).
        // Still passes through the breaker so a misconfiguration on start-up
        // can trip the circuit and surface in /health dashboards.
        dependencies.in_memory_store = {
          status: 'ok',
          details: { note: 'No rate limiter configured for probing' },
        };
      }
    } catch (error) {
      // ── Circuit breaker is OPEN — fast-fail with 503 ───────────────────────
      if (error instanceof CircuitBreakerOpenError) {
        logger.warn('[rate-limit/health] circuit breaker open — fast-failing request', {
          correlationId,
          slug: RATE_LIMIT_HEALTH_BREAKER_SLUG,
          error: error.message,
        });
        // Delegate to the global errorHandler for a consistent error envelope.
        return next(
          new ServiceUnavailableError(
            'Rate-limit store circuit breaker is open. Downstream dependency is unavailable.',
          ),
        );
      }

      // ── Any other probe error — record as "down" ───────────────────────────
      const responseTime = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      dependencies.in_memory_store = {
        status: 'down',
        responseTime: Number(responseTime.toFixed(3)),
        error: 'unavailable',
      };

      logger.error('[rate-limit/health] limiter probe failed', {
        correlationId,
        error,
        slug: RATE_LIMIT_HEALTH_BREAKER_SLUG,
      });
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
