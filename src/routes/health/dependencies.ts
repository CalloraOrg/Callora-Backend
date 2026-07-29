/**
 * Health Dependencies Probe
 *
 * Per-dependency health probe endpoint that returns individual status,
 * response time, and sanitized error information for each configured
 * system dependency (database, Soroban RPC, Horizon).
 *
 * Designed for operations dashboards and fine-grained alerting —
 * complementing the aggregate `/api/health` endpoint used by
 * load balancers.
 */

import { Router } from 'express';
import type { HealthCheckConfig, ComponentCheck } from '../../services/healthCheck.js';
import { checkDatabase, checkSorobanRpc, checkHorizon, determineOverallStatus } from '../../services/healthCheck.js';
import { InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';

/** Response body for the dependencies probe endpoint. */
export interface DependencyProbeResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  dependencies: Record<string, ComponentCheck>;
}

/**
 * Sanitises a {@link ComponentCheck} for external exposure.
 *
 * Replaces raw internal error messages with safe categories to prevent
 * leaking connection strings, hostnames, or stack details.
 */
export function sanitizeCheck(check: ComponentCheck): ComponentCheck {
  const sanitized: ComponentCheck = { status: check.status };

  if (check.responseTime !== undefined) {
    sanitized.responseTime = check.responseTime;
  }

  if (check.error) {
    if (check.error === 'Timeout' || check.error === 'Database check timeout') {
      sanitized.error = 'timeout';
    } else if (check.error.startsWith('HTTP ')) {
      sanitized.error = check.error;
    } else if (check.error === 'Unexpected query result') {
      sanitized.error = 'unexpected_response';
    } else {
      sanitized.error = 'unavailable';
    }
  }

  return sanitized;
}

/**
 * Creates a router for the per-dependency health probe.
 *
 * @param config - Optional health check configuration. When omitted,
 *   returns an empty dependencies object (no probes to run).
 */
export function createDependenciesRouter(config?: HealthCheckConfig): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    const requestId = req.id || 'unknown';
    logger.info('[health/dependencies] probe requested', { requestId });

    // No config → no dependencies to probe
    if (!config?.database) {
      const response: DependencyProbeResponse = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        dependencies: {},
      };
      res.json(response);
      return;
    }

    try {
      const dependencies: Record<string, ComponentCheck> = {};

      const [dbCheck, sorobanCheck, horizonCheck] = await Promise.all([
        checkDatabase(config.database.pool, config.database.timeout),
        config.sorobanRpc
          ? checkSorobanRpc(config.sorobanRpc.url, config.sorobanRpc.timeout)
          : Promise.resolve(undefined),
        config.horizon
          ? checkHorizon(config.horizon.url, config.horizon.timeout)
          : Promise.resolve(undefined),
      ]);

      dependencies.database = sanitizeCheck(dbCheck);

      if (sorobanCheck) {
        dependencies.soroban_rpc = sanitizeCheck(sorobanCheck);
      }

      if (horizonCheck) {
        dependencies.horizon = sanitizeCheck(horizonCheck);
      }

      const overallStatus = determineOverallStatus({
        api: 'ok',
        database: dbCheck.status,
        soroban_rpc: sorobanCheck?.status,
        horizon: horizonCheck?.status,
      });

      logger.info('[health/dependencies] probe completed', {
        requestId,
        overallStatus,
        statuses: Object.fromEntries(
          Object.entries(dependencies).map(([k, v]) => [k, v.status]),
        ),
      });

      const response: DependencyProbeResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        dependencies,
      };

      const statusCode = overallStatus === 'down' ? 503 : 200;
      res.status(statusCode).json(response);
    } catch (error) {
      logger.error('[health/dependencies] probe failed', { requestId, error });
      next(new InternalServerError());
    }
  });

  return router;
}
