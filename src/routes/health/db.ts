import { Router } from 'express';
import { pool } from '../../db.js';
import { logger } from '../../logger.js';
import { InternalServerError } from '../../errors/index.js';

/**
 * Creates a router for the database pool stats endpoint.
 */
export function createDbHealthRouter(): Router {
  const router = Router();

  router.get('/', (req, res, next) => {
    const requestId = req.id || 'unknown';
    logger.info('[health/db] pool stats requested', { requestId });

    try {
      // The pg.Pool object natively exposes these metrics
      const stats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };

      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        pool: stats,
      });
    } catch (error) {
      logger.error('[health/db] pool stats retrieval failed', { requestId, error });
      next(new InternalServerError());
    }
  });

  return router;
}