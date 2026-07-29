import { Router } from 'express';
import {
  createMaintenanceCorsMiddleware,
} from '../middleware/cors.js';
import { maintenanceHistogramMiddleware } from '../middleware/metricsHistogram.js';
import { etagMiddleware } from '../middleware/etag.js';
import { logger } from '../logger.js';
import { getRequestId, successEnvelope } from '../lib/envelope.js';
import { activeMaintenanceWindow } from './admin/maintenance.js';

/**
 * Public maintenance status router.
 *
 * Mounted at `/api/maintenance` (without the `/admin` prefix) so that
 * external monitoring dashboards and the GrantFox FWC26 campaign status
 * page can read the current maintenance window without requiring admin
 * credentials. The endpoint is read-only — only the admin router at
 * `/api/admin/maintenance` may mutate the underlying state.
 *
 * Cross-origin protection is enforced by {@link createMaintenanceCorsMiddleware}
 * against the `MAINTENANCE_CORS_ALLOWED_ORIGINS` env var (deny-by-default
 * when unset, 10-minute preflight cache, credentials enabled).
 */
const maintenanceCors = createMaintenanceCorsMiddleware();

export const publicMaintenanceRouter = Router();

publicMaintenanceRouter.use(maintenanceCors);
publicMaintenanceRouter.use(maintenanceHistogramMiddleware);
publicMaintenanceRouter.use(etagMiddleware);

/**
 * GET /api/maintenance — return the current maintenance window state.
 *
 * Always returns 200 with the live snapshot. Clients that need to know
 * whether the system is *currently within* a maintenance window should
 * rely on `/healthz`, which returns 503 in that case.
 *
 * Returns a strong ETag based on the response body. Honors `If-None-Match`
 * with a 304 Not Modified to save bandwidth on repeat reads.
 *
 * Headers:
 *   X-Request-Id: correlation id for the request, also returned in body.
 *   Vary: Origin  — required because the CORS headers are origin-specific.
 *   ETag: strong hash of the serialised response body.
 */
publicMaintenanceRouter.get('/', (req, res) => {
  const correlationId = getRequestId(req);
  logger.info('public maintenance status requested', { correlationId });
  res.status(200).json(successEnvelope(activeMaintenanceWindow, correlationId));
});

export default publicMaintenanceRouter;
