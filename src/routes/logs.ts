/**
 * src/routes/logs.ts
 *
 * Developer-facing log endpoints. Every route in this router propagates the
 * X-Correlation-Id header so that callers can correlate multi-hop request
 * chains across log queries and outbound calls.
 *
 * Mounted at /api/logs in app.ts.
 *
 * Endpoints:
 *   GET /api/logs          – List log entries for the authenticated developer
 *   GET /api/logs/:id      – Fetch a single log entry by ID
 *
 * Security: all routes require JWT authentication; users see only their own
 * log entries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { correlationMiddleware } from '../middleware/correlation.js';
import { PgAuditLogRepository, type AuditLogRepository } from '../repositories/auditLogRepository.js';
import { NotFoundError, UnauthorizedError } from '../errors/index.js';
import { logger } from '../logger.js';

/**
 * Interface for logs router dependencies, enabling dependency injection for
 * tests and alternative backends.
 */
export interface LogsRouterDeps {
  auditLogRepository?: AuditLogRepository;
}

/**
 * Creates the logs router with dependency injection support.
 *
 * @param deps - Optional dependency overrides (used primarily in tests).
 */
export function createLogsRouter(deps: LogsRouterDeps = {}): Router {
  const router = Router();
  const auditLogRepository = deps.auditLogRepository ?? new PgAuditLogRepository();

  // Apply correlation middleware to every route in this router so that the
  // X-Correlation-Id header is propagated through all log handlers and any
  // outbound calls they make.
  router.use(correlationMiddleware);

  /**
   * GET /api/logs
   *
   * Returns audit log entries for the authenticated developer, ordered by
   * creation time (most recent first).
   *
   * The X-Correlation-Id header is set automatically by the correlation
   * middleware; the client may supply an incoming correlation ID, otherwise
   * a fresh UUID is generated.
   */
  router.get(
    '/',
    requireAuth,
    async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const correlationId = (req as Request & { correlationId?: string }).correlationId;

        const entries = await auditLogRepository.findCursor({
          limit: 50,
          actor: user.id,
        });

        logger.info('Log entries listed', {
          developerId: user.id,
          correlationId,
          count: entries.entries.length,
        });

        res.json({
          data: entries.entries,
          correlationId,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * GET /api/logs/:id
   *
   * Returns a single log entry by ID. The entry must belong to the
   * authenticated developer; cross-user access returns 404.
   */
  router.get(
    '/:id',
    requireAuth,
    async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const correlationId = (req as Request & { correlationId?: string }).correlationId;
        const { id } = req.params;

        const entries = await auditLogRepository.findCursor({
          limit: 1,
          actor: user.id,
        });

        const entry = entries.entries.find((e) => e.id === id);
        if (!entry) {
          throw new NotFoundError('Log entry not found', 'LOG_ENTRY_NOT_FOUND');
        }

        logger.info('Log entry fetched', {
          developerId: user.id,
          logId: id,
          correlationId,
        });

        res.json({
          data: entry,
          correlationId,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

export default createLogsRouter;
