/**
 * Admin Health Probes Router
 *
 * Provides detailed health monitoring on a per-component basis.
 * Accessible only by administrators under /api/admin/health/probes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { pool as defaultPool } from '../../../../db.js';
import { config as defaultConfig } from '../../../../config/index.js';
import {
  checkDatabase,
  checkSorobanRpc,
  checkHorizon,
  determineOverallStatus,
  type ComponentStatus,
  type ComponentCheck,
} from '../../../../services/healthCheck.js';
import { BadRequestError, NotFoundError, InternalServerError } from '../../../../errors/index.js';
import { logger } from '../../../../logger.js';
import { getClientIp } from '../../../../lib/clientIp.js';
import { validate } from '../../../../middleware/validate.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

export interface AdminHealthProbesDeps {
  pool?: any;
  config?: any;
}

const componentParamSchema = z.object({
  component: z.enum(['api', 'database', 'soroban_rpc', 'horizon']),
});

/**
 * Factory that returns the admin health probes sub-router.
 * Mount it under the existing admin router, e.g.:
 *   adminRouter.use('/health/probes', createAdminHealthProbesRouter());
 */
export function createAdminHealthProbesRouter(deps: AdminHealthProbesDeps = {}): Router {
  const router = Router();
  const pool = deps.pool ?? defaultPool;
  const config = deps.config ?? defaultConfig;

  // Helper to run health check for a single component
  const runComponentCheck = async (component: string): Promise<ComponentCheck> => {
    switch (component) {
      case 'api':
        // API is healthy if the request reaches here
        return { status: 'ok', responseTime: 0 };
      case 'database':
        return await checkDatabase(pool, config.database?.timeout);
      case 'soroban_rpc':
        if (!config.sorobanRpc) {
          throw new NotFoundError('Soroban RPC component is not configured', 'COMPONENT_NOT_CONFIGURED');
        }
        return await checkSorobanRpc(config.sorobanRpc.url, config.sorobanRpc.timeout);
      case 'horizon':
        if (!config.horizon) {
          throw new NotFoundError('Horizon component is not configured', 'COMPONENT_NOT_CONFIGURED');
        }
        return await checkHorizon(config.horizon.url, config.horizon.timeout);
      default:
        throw new BadRequestError(`Invalid component: ${component}`);
    }
  };

  // ── GET /api/admin/health/probes ─────────────────────────────────────────
  /**
   * Get detailed health status of all components.
   */
  router.get('/', async (req, res, next) => {
    try {
      const components: Record<string, ComponentCheck> = {};

      const dbPromise = checkDatabase(pool, config.database?.timeout);
      const sorobanPromise = config.sorobanRpc
        ? checkSorobanRpc(config.sorobanRpc.url, config.sorobanRpc.timeout)
        : Promise.resolve(undefined);
      const horizonPromise = config.horizon
        ? checkHorizon(config.horizon.url, config.horizon.timeout)
        : Promise.resolve(undefined);

      const [dbCheck, sorobanCheck, horizonCheck] = await Promise.all([
        dbPromise,
        sorobanPromise,
        horizonPromise,
      ]);

      components.api = { status: 'ok', responseTime: 0 };
      components.database = dbCheck;
      if (config.sorobanRpc && sorobanCheck) {
        components.soroban_rpc = sorobanCheck;
      }
      if (config.horizon && horizonCheck) {
        components.horizon = horizonCheck;
      }

      const statuses = {
        api: components.api.status,
        database: components.database.status,
        ...(components.soroban_rpc && { soroban_rpc: components.soroban_rpc.status }),
        ...(components.horizon && { horizon: components.horizon.status }),
      };

      const overallStatus = determineOverallStatus(statuses);
      const statusCode = overallStatus === 'down' ? 503 : 200;

      logger.audit('READ_HEALTH_PROBES', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        overallStatus,
      });

      res.status(statusCode).json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        version: config.version,
        components,
      });
    } catch (error) {
      logger.error('Failed to perform admin health probes:', error);
      next(new InternalServerError());
    }
  });

  // ── GET /api/admin/health/probes/:component ──────────────────────────────
  /**
   * Get detailed health status of a specific component.
   */
  router.get(
    '/:component',
    validate({ params: componentParamSchema }),
    async (req, res, next) => {
      const { component } = req.params;
      try {
        const result = await runComponentCheck(component);
        const statusCode = result.status === 'down' ? 503 : 200;

        logger.audit('READ_HEALTH_PROBE_COMPONENT', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          component,
          status: result.status,
        });

        res.status(statusCode).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

export default createAdminHealthProbesRouter;
