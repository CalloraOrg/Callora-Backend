/**
 * Admin Circuit Breaker Router
 *
 * Provides endpoints to inspect and manage circuit breaker state from the admin panel.
 * Accessible only by administrators under /api/admin/circuit-breakers.
 *
 * Routes:
 *   GET    /api/admin/circuit-breakers              — List all registered breakers
 *   GET    /api/admin/circuit-breakers/:breakerKey  — Get details for a specific breaker
 *   POST   /api/admin/circuit-breakers/:breakerKey/reset — Force-reset a breaker to CLOSED
 *   POST   /api/admin/circuit-breakers/:breakerKey/trip   — Force-trip a breaker to OPEN
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  BreakerRegistry,
  CircuitBreakerState,
  getDefaultBreakerRegistry,
} from '../../lib/circuitBreaker.js';
import {
  NotFoundError,
  InternalServerError,
  AppError,
} from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getClientIp } from '../../lib/clientIp.js';
import { validate } from '../../middleware/validate.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const BREAKER_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const breakerKeyParamSchema = z.object({
  breakerKey: z.string().regex(BREAKER_KEY_PATTERN, 'breakerKey must be 1-128 alphanumeric, hyphen, or underscore characters'),
});

const tripBodySchema = z.object({
  reason: z.string().max(512).optional(),
});

export interface AdminCircuitBreakerRouterDeps {
  registry?: BreakerRegistry;
}

function mapState(state: CircuitBreakerState): string {
  return state.toLowerCase().replace('_', '-');
}

/**
 * Factory that returns the admin circuit breaker sub-router.
 * Mount it under the existing admin router, e.g.:
 *   adminRouter.use('/circuit-breakers', createAdminCircuitBreakerRouter());
 */
export function createAdminCircuitBreakerRouter(
  deps: AdminCircuitBreakerRouterDeps = {},
): Router {
  const router = Router();
  const registry = deps.registry ?? getDefaultBreakerRegistry();

  // ── GET /api/admin/circuit-breakers ────────────────────────────────────
  /**
   * List all registered circuit breakers with their current state and metrics.
   */
  router.get('/', async (req, res, next) => {
    try {
      const entries = await registry.list();

      logger.audit('LIST_CIRCUIT_BREAKERS', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
        count: entries.length,
      });

      res.json({
        data: entries.map((e) => ({
          slug: e.slug,
          state: mapState(e.state),
          metrics: e.metrics,
        })),
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to list circuit breakers', { error });
      next(new InternalServerError());
    }
  });

  // ── GET /api/admin/circuit-breakers/:breakerKey ────────────────────────
  /**
   * Get detailed state and metrics for a specific circuit breaker.
   */
  router.get(
    '/:breakerKey',
    validate({ params: breakerKeyParamSchema }),
    async (req, res, next) => {
      try {
        const { breakerKey } = req.params;
        const breaker = registry.get(breakerKey);

        if (!breaker) {
          next(new NotFoundError(`Circuit breaker "${breakerKey}" not found`));
          return;
        }

        const metrics = await breaker.getMetrics(breakerKey);

        logger.audit('READ_CIRCUIT_BREAKER', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
          breakerKey,
          state: mapState(metrics.state),
        });

        res.json({
          data: {
            slug: breakerKey,
            state: mapState(metrics.state),
            metrics,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }
        logger.error('Failed to read circuit breaker', { error, breakerKey: req.params.breakerKey });
        next(new InternalServerError());
      }
    },
  );

  // ── POST /api/admin/circuit-breakers/:breakerKey/reset ─────────────────
  /**
   * Force-reset a circuit breaker to CLOSED state, allowing requests to flow again.
   */
  router.post(
    '/:breakerKey/reset',
    validate({ params: breakerKeyParamSchema }),
    async (req, res, next) => {
      try {
        const { breakerKey } = req.params;
        const breaker = registry.get(breakerKey);

        if (!breaker) {
          next(new NotFoundError(`Circuit breaker "${breakerKey}" not found`));
          return;
        }

        const priorState = await breaker.getState(breakerKey);
        await breaker.reset(breakerKey);

        logger.audit('RESET_CIRCUIT_BREAKER', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
          breakerKey,
          priorState: mapState(priorState),
          currentState: 'closed',
        });

        res.json({
          data: {
            slug: breakerKey,
            priorState: mapState(priorState),
            currentState: 'closed',
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }
        logger.error('Failed to reset circuit breaker', { error, breakerKey: req.params.breakerKey });
        next(new InternalServerError());
      }
    },
  );

  // ── POST /api/admin/circuit-breakers/:breakerKey/trip ──────────────────
  /**
   * Force-trip a circuit breaker to OPEN state, immediately rejecting all requests.
   * Useful for manual intervention or emergency shutdown of a downstream dependency.
   */
  router.post(
    '/:breakerKey/trip',
    validate({ params: breakerKeyParamSchema, body: tripBodySchema }),
    async (req, res, next) => {
      try {
        const { breakerKey } = req.params;
        let breaker = registry.get(breakerKey);

        if (!breaker) {
          breaker = registry.getOrCreate(breakerKey);
        }

        const priorState = await breaker.getState(breakerKey);

        if (priorState === CircuitBreakerState.OPEN) {
          res.json({
            data: {
              slug: breakerKey,
              priorState: mapState(priorState),
              currentState: 'open',
              message: 'Circuit breaker is already open',
            },
          });
          return;
        }

        const reason = req.body.reason ?? 'Manual trip via admin API';

        await breaker.trip(breakerKey);
        const currentState = await breaker.getState(breakerKey);

        logger.audit('TRIP_CIRCUIT_BREAKER', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
          breakerKey,
          priorState: mapState(priorState),
          currentState: mapState(currentState),
          reason,
        });

        res.json({
          data: {
            slug: breakerKey,
            priorState: mapState(priorState),
            currentState: mapState(currentState),
            reason,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }
        logger.error('Failed to trip circuit breaker', { error, breakerKey: req.params.breakerKey });
        next(new InternalServerError());
      }
    },
  );

  return router;
}

export default createAdminCircuitBreakerRouter;
