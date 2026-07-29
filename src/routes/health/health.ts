/**
 * Health Dependency Probe Route
 *
 * Provides `GET /api/health/health` — a dependency-level health probe
 * that enumerates every configured external dependency (database,
 * Soroban RPC, Horizon) with individual status, response time, and
 * sanitized error information.
 *
 * Designed for operations dashboards, fine-grained alerting, and
 * deep-health probes that go beyond the aggregate `/api/health`
 * status used by load balancers.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  HealthCheckConfig,
  ComponentCheck,
} from '../../services/healthCheck.js';
import {
  checkDatabase,
  checkSorobanRpc,
  checkHorizon,
  determineOverallStatus,
} from '../../services/healthCheck.js';
import { activeMaintenanceWindow } from '../admin/maintenance.js';
import { logger } from '../../logger.js';
import { getRequestId, successEnvelope, errorEnvelope } from '../../lib/envelope.js';

/** Status of a single external dependency. */
export interface DependencyEntry {
  status: 'ok' | 'degraded' | 'down';
  responseTime?: number;
  error?: string;
}

/** Response body for the dependency health probe. */
export interface HealthDependencyProbeResponse {
  status: 'ok' | 'degraded' | 'down';
  version?: string;
  timestamp: string;
  dependencies: Record<string, DependencyEntry>;
}

/**
 * Sanitizes a {@link ComponentCheck} for external exposure.
 *
 * Replaces raw internal error messages with safe categories to prevent
 * leaking connection strings, hostnames, or stack traces.
 */
export function sanitizeDependencyCheck(check: ComponentCheck): DependencyEntry {
  const sanitized: DependencyEntry = { status: check.status };

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
 * Creates a router for the health dependency probe endpoint.
 *
 * @param config - Optional health check configuration. When omitted,
 *   returns a basic ok status with no dependency details.
 * @param version - Optional application version string to include in
 *   the response body.
 */
export function createHealthDependencyRouter(
  config?: HealthCheckConfig,
  version?: string,
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const requestId = getRequestId(req);
    res.setHeader('x-request-id', requestId);

    // Maintenance window check — short-circuit before probing dependencies
    const now = new Date();
    const isUnderMaintenance =
      activeMaintenanceWindow.isEnabled &&
      activeMaintenanceWindow.startTime &&
      activeMaintenanceWindow.endTime &&
      now >= new Date(activeMaintenanceWindow.startTime) &&
      now <= new Date(activeMaintenanceWindow.endTime);

    if (isUnderMaintenance) {
      logger.info('[health/health] probe skipped — maintenance window active', {
        requestId,
      });
      res.status(503).json(
        successEnvelope(
          {
            status: 'MAINTENANCE' as const,
            version,
            timestamp: now.toISOString(),
            dependencies: {},
            maintenance: {
              reason: activeMaintenanceWindow.reason,
              expiresAt: activeMaintenanceWindow.endTime,
            },
          },
          requestId,
        ),
      );
      return;
    }

    // No config → return basic ok status with empty dependencies
    if (!config?.database) {
      logger.info('[health/health] probe requested (no config)', { requestId });
      const response: HealthDependencyProbeResponse = {
        status: 'ok',
        version,
        timestamp: now.toISOString(),
        dependencies: {},
      };
      res.status(200).json(successEnvelope(response, requestId));
      return;
    }

    logger.info('[health/health] probe requested', { requestId });

    try {
      const dependencies: Record<string, DependencyEntry> = {};

      const [dbCheck, sorobanCheck, horizonCheck] = await Promise.all([
        checkDatabase(config.database.pool, config.database.timeout),
        config.sorobanRpc
          ? checkSorobanRpc(config.sorobanRpc.url, config.sorobanRpc.timeout)
          : Promise.resolve(undefined),
        config.horizon
          ? checkHorizon(config.horizon.url, config.horizon.timeout)
          : Promise.resolve(undefined),
      ]);

      dependencies.database = sanitizeDependencyCheck(dbCheck);

      if (sorobanCheck) {
        dependencies.soroban_rpc = sanitizeDependencyCheck(sorobanCheck);
      }

      if (horizonCheck) {
        dependencies.horizon = sanitizeDependencyCheck(horizonCheck);
      }

      const overallStatus = determineOverallStatus({
        api: 'ok',
        database: dbCheck.status,
        soroban_rpc: sorobanCheck?.status,
        horizon: horizonCheck?.status,
      });

      logger.info('[health/health] probe completed', {
        requestId,
        overallStatus,
        statuses: Object.fromEntries(
          Object.entries(dependencies).map(([k, v]) => [k, v.status]),
        ),
      });

      const response: HealthDependencyProbeResponse = {
        status: overallStatus,
        version,
        timestamp: now.toISOString(),
        dependencies,
      };

      const statusCode = overallStatus === 'down' ? 503 : 200;
      res.status(statusCode).json(successEnvelope(response, requestId));
    } catch (error) {
      logger.error('[health/health] probe failed unexpectedly', {
        requestId,
        error,
      });
      res.status(503).json(
        errorEnvelope(
          'SERVICE_UNAVAILABLE',
          'Health dependency probe failed',
          requestId,
        ),
      );
    }
  });

  return router;
}
