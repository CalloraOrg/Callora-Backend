import { Router, type Request, type Response } from 'express';
import { createMaintenanceCorsMiddleware } from '../../middleware/cors.js';
import { logger } from '../../logger.js';
import { getRequestId, successEnvelope } from '../../lib/envelope.js';

/**
 * Extract the per-request correlation id, preferring `X-Request-Id` (the
 * canonical header used by {@link requestIdMiddleware} elsewhere in the
 * app) but falling back to `X-Correlation-Id` for callers that still
 * expect the legacy header convention. If neither header is present the
 * helper from `src/lib/envelope.ts` synthesises a UUID.
 *
 * Setting both response headers ensures existing clients that introspect
 * either name continue to work after the canonical rename.
 */
function resolveCorrelationId(req: Request): string {
  const explicit = req.headers['x-correlation-id'];
  const header = Array.isArray(explicit) ? explicit[0] : explicit;
  if (header && header.length > 0) {
    return header;
  }
  return getRequestId(req);
}

/**
 * Write both `X-Request-Id` (canonical — used by {@link requestIdMiddleware}
 * and `src/lib/envelope.ts`) and `X-Correlation-Id` (legacy — used by older
 * callers) on the outbound response so the request id is reachable from
 * either header convention. The id used here MUST be the same one passed
 * to `successEnvelope`/`errorEnvelope` so the headers, the body envelope,
 * and the `correlationId` legacy field all agree byte-for-byte.
 */
function propagateCorrelationHeaders(res: Response, correlationId: string): void {
  res.setHeader('X-Request-Id', correlationId);
  res.setHeader('X-Correlation-Id', correlationId);
}

/**
 * Admin maintenance configuration router.
 *
 * Routes (mounted under `/api/admin` in `src/routes/admin.ts`):
 *   POST /api/admin/maintenance — create or replace the active maintenance
 *                                  window. Operators set `isEnabled=true`
 *                                  together with ISO-8601 `startTime` and
 *                                  `endTime`; clearing maintenance sets
 *                                  `isEnabled=false`.
 *   GET  /api/admin/maintenance — current maintenance state.
 *
 * Cross-origin protection for both routes is enforced by
 * {@link createMaintenanceCorsMiddleware} at module load. The middleware
 * reads `MAINTENANCE_CORS_ALLOWED_ORIGINS` on first request and applies an
 * exact-match allowlist with credentials enabled and a 10-minute preflight
 * cache. When the env var is unset/empty every cross-origin request is
 * denied (deny by default).
 */

/**
 * Active maintenance window state. Exported so read-only consumers
 * (e.g. `/api/maintenance`, `src/routes/healthz.ts`,
 * `src/routes/health.ts`) can derive their responses.
 */
export interface MaintenanceWindowState {
  isEnabled: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string;
}

export let activeMaintenanceWindow: MaintenanceWindowState = {
  isEnabled: false,
  startTime: null,
  endTime: null,
  reason: '',
};

const maintenanceCors = createMaintenanceCorsMiddleware();

export const maintenanceRouter = Router();

// Apply the env-driven CORS allowlist first so every handler below it is
// protected by the same policy.
maintenanceRouter.use(maintenanceCors);

/**
 * POST /api/admin/maintenance — set the active maintenance window.
 *
 * Body:
 *   isEnabled (boolean, required)
 *   startTime (string, ISO-8601, required when `isEnabled=true`)
 *   endTime   (string, ISO-8601, required when `isEnabled=true`)
 *   reason    (string, optional, default "Scheduled infrastructure updates.")
 *
 * Returns the new active window in the standard success envelope.
 */
maintenanceRouter.post('/maintenance', (req, res): void => {
  const correlationId = resolveCorrelationId(req);
  propagateCorrelationHeaders(res, correlationId);
  const { isEnabled, startTime, endTime, reason } = req.body ?? {};

  logger.info('Maintenance window update requested', {
    correlationId,
    isEnabled,
  });

  if (typeof isEnabled !== 'boolean') {
    logger.warn('Maintenance update rejected: missing isEnabled boolean', {
      correlationId,
    });
    res.status(400).json({
      error: 'Property "isEnabled" must be an explicit boolean value.',
      correlationId,
    });
    return;
  }

  if (isEnabled) {
    if (!startTime || !endTime) {
      res.status(400).json({
        error:
          'startTime and endTime ISO parameters are mandatory when maintenance is active.',
        correlationId,
      });
      return;
    }

    // Reject purely numeric strings and other invalid date formats up front;
    // Date.parse happily accepts "2020" then turns into 2020-01-01T00:00:00Z.
    const startParsed = Date.parse(startTime);
    const endParsed = Date.parse(endTime);
    if (
      Number.isNaN(startParsed) ||
      !Number.isNaN(Number(startTime)) ||
      Number.isNaN(endParsed) ||
      !Number.isNaN(Number(endTime))
    ) {
      res.status(400).json({
        error: 'Invalid ISO date strings provided for tracking windows.',
        correlationId,
      });
      return;
    }
  }

  activeMaintenanceWindow = {
    isEnabled,
    startTime: isEnabled ? new Date(startTime).toISOString() : null,
    endTime: isEnabled ? new Date(endTime).toISOString() : null,
    reason: typeof reason === 'string' && reason.length > 0
      ? reason
      : 'Scheduled infrastructure updates.',
  };

  logger.info('Maintenance window updated', {
    correlationId,
    // Avoid logging the full activeMaintenanceWindow because fields like
    // reason may contain operator-supplied text we don't want in audits.
    isEnabled: activeMaintenanceWindow.isEnabled,
  });

  // Wrap the new window in the canonical success envelope but also keep
  // the legacy `message` / `correlationId` fields at the top level so
  // existing consumers (and the existing integration tests in
  // src/routes/__tests__/maintenance.test.ts) keep working.
  res.status(200).json({
    ...successEnvelope(activeMaintenanceWindow, correlationId, {
      message: 'Maintenance window state configurations updated successfully.',
    }),
    // Back-compat aliases — previous responses exposed `message` and
    // `correlationId` flat. New code should read from `meta.message` and
    // `requestId` instead.
    message: 'Maintenance window state configurations updated successfully.',
    correlationId,
  });
});

/**
 * GET /api/admin/maintenance — return the current active window.
 *
 * Note: this endpoint, and the public read endpoint at `/api/maintenance`,
 * intentionally do NOT leak whether the system is currently *within* a
 * maintenance window — clients should rely on the 503 surfaced by
 * `/healthz` to know the system is paused.
 */
maintenanceRouter.get('/maintenance', (req, res) => {
  const correlationId = resolveCorrelationId(req);
  propagateCorrelationHeaders(res, correlationId);
  logger.info('Maintenance window status requested', { correlationId });
  // Wrap the live state in the canonical success envelope but also keep
  // `correlationId` flat at the top level for back-compat with existing
  // clients and tests. New code should use `requestId` instead.
  res.status(200).json({
    ...successEnvelope(activeMaintenanceWindow, correlationId),
    correlationId,
  });
});
