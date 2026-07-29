/**
 * Invoices Health Dependency Probe
 *
 * Provides `GET /api/invoices/health` — a dependency-level health probe
 * that enumerates every configured external dependency (database,
 * Soroban RPC, Horizon) with individual status, response time, and
 * sanitized error information.
 *
 * Designed for operations dashboards, fine-grained alerting, and
 * monitoring of the invoices subsystem's upstream dependencies.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config as defaultConfig } from '../../../src/config/index.ts';
import {
  checkDatabase,
  checkSorobanRpc,
  checkHorizon,
  determineOverallStatus,
  type ComponentCheck,
} from '../../../src/services/healthCheck.ts';
import type { HealthCheckConfig } from '../../../src/services/healthCheck.ts';
import { logger } from '../../../src/logger.ts';
import { getRequestId, successEnvelope, errorEnvelope } from '../../../src/lib/envelope.js';

/** Status of a single external dependency. */
export interface DependencyEntry {
  status: 'ok' | 'degraded' | 'down';
  responseTime?: number;
  error?: string;
}

/** Response body for the invoices health probe. */
export interface InvoicesHealthResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  version?: string;
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

export interface InvoicesHealthDeps {
  config?: HealthCheckConfig;
}

/**
  * Creates a router for the invoices health dependency probe endpoint.
  *
  * @param deps - Optional dependencies. When `config` is omitted, the default
  *   config from `src/config/index.ts` is used.
  */
export function createInvoicesHealthRouter(deps: InvoicesHealthDeps = {}): Router {
  const router = Router();
  const config = deps.config ?? defaultConfig;

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const requestId = getRequestId(req);
    res.setHeader('x-request-id', requestId);

    // No config → return basic ok status with empty dependencies
    if (!config?.database) {
      logger.info('[invoices/health] probe requested (no config)', { requestId });
      const response: InvoicesHealthResponse = {
        status: 'ok',
        version: config.version,
        timestamp: new Date().toISOString(),
        dependencies: {},
      };
      res.status(200).json(successEnvelope(response, requestId));
      return;
    }

    logger.info('[invoices/health] probe requested', { requestId });

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

      logger.info('[invoices/health] probe completed', {
        requestId,
        overallStatus,
        statuses: Object.fromEntries(
          Object.entries(dependencies).map(([k, v]) => [k, v.status]),
        ),
      });

      const response: InvoicesHealthResponse = {
        status: overallStatus,
        version: config.version,
        timestamp: new Date().toISOString(),
        dependencies,
      };

      const statusCode = overallStatus === 'down' ? 503 : 200;
      res.status(statusCode).json(successEnvelope(response, requestId));
    } catch (error) {
      logger.error('[invoices/health] probe failed unexpectedly', {
        requestId,
        error,
      });
      res.status(503).json(
        errorEnvelope(
          'SERVICE_UNAVAILABLE',
          'Invoices health probe failed',
          requestId,
        ),
      );
    }
  });

  return router;
}