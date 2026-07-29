/**
 * Quota subsystem dependency probe — GET /api/quotas/health
 *
 * Reports the status of the external dependencies the `/api/quotas` route
 * group (this router plus src/routes/quotas/counts.ts and
 * src/services/quotaService.ts) relies on to function. Today that is the
 * shared PostgreSQL database: quota request data is ultimately persisted
 * there and `listQuotaRequests()` / usage aggregation both depend on it
 * being reachable.
 *
 * Response shape mirrors `/api/health/dependencies`
 * (src/routes/health/dependencies.ts) — same `{ status, timestamp,
 * dependencies }` envelope and the same {@link sanitizeCheck} rules — so ops
 * tooling can treat every dependency probe in the app uniformly. Designed
 * for monitoring dashboards / alerting, not for end users, so it does not
 * require authentication (matching the global dependencies probe).
 *
 * ### Correlation IDs & graceful shutdown
 * Mounts the same {@link correlationMiddleware} used by
 * src/routes/quotas/counts.ts so every request carries an `X-Correlation-Id`
 * for structured logging, and reuses the shared {@link quotasDrainTracker}
 * so in-flight probe requests are drained on shutdown along with the rest
 * of the `/api/quotas` surface.
 *
 * @module routes/quotas/health
 */

import { Router } from 'express';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../db.js';
import {
  checkDatabase,
  determineOverallStatus,
  type ComponentCheck,
  type ComponentStatus,
} from '../../services/healthCheck.js';
import { sanitizeCheck } from '../health/dependencies.js';
import { correlationMiddleware } from '../../middleware/correlation.js';
import { quotasDrainTracker } from './counts.js';
import { InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';

/** Response body for GET /api/quotas/health. */
export interface QuotaHealthProbeResponse {
  status: ComponentStatus;
  timestamp: string;
  dependencies: Record<string, ComponentCheck>;
  /** Correlation ID echoed back from the request context. */
  correlationId?: string;
}

export interface QuotaHealthRouterDeps {
  /** Postgres pool to probe. Defaults to the shared app pool (src/db.ts). */
  pool?: Pool;
  /** Per-check timeout in ms, forwarded to {@link checkDatabase}. */
  timeoutMs?: number;
}

/**
 * Builds the `/api/quotas/health` router.
 *
 * @param deps Optional dependency overrides — primarily for unit tests that
 *   need to inject a mock pool to simulate a healthy or unreachable database.
 */
export function createQuotaHealthRouter(deps: QuotaHealthRouterDeps = {}): Router {
  const router = Router();
  const pool = deps.pool ?? defaultPool;

  // Structured logging correlation ID, matching the rest of /api/quotas.
  router.use(correlationMiddleware);

  // Count this request against the shared quotas in-flight drain tracker so
  // graceful shutdown waits for it just like any other /api/quotas request.
  router.use(quotasDrainTracker.middleware);

  router.get('/', async (req: Request, res, next) => {
    const requestId = req.id || 'unknown';
    const correlationId = (req as Request & { correlationId?: string }).correlationId;

    logger.info('[quotas/health] probe requested', { requestId, correlationId });

    try {
      const dbCheck = await checkDatabase(pool, deps.timeoutMs);
      const dependencies: Record<string, ComponentCheck> = {
        database: sanitizeCheck(dbCheck),
      };

      const overallStatus = determineOverallStatus({
        api: 'ok',
        database: dbCheck.status,
      });

      logger.info('[quotas/health] probe completed', {
        requestId,
        correlationId,
        overallStatus,
        statuses: Object.fromEntries(
          Object.entries(dependencies).map(([key, value]) => [key, value.status]),
        ),
      });

      const response: QuotaHealthProbeResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        dependencies,
        correlationId,
      };

      const statusCode = overallStatus === 'down' ? 503 : 200;
      res.status(statusCode).json(response);
    } catch (error) {
      logger.error('[quotas/health] probe failed', { requestId, correlationId, error });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createQuotaHealthRouter;
