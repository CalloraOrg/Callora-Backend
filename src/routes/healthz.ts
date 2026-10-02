import { Router, Request, Response } from 'express';
import { activeMaintenanceWindow } from './admin/maintenance.js';

export const healthzRouter = Router();

/**
 * GET /healthz — liveness probe.
 *
 * Invariants enforced here (and guarded by src/routes/healthz.test.ts):
 *   - Cheap and dependency-free: the handler only reads in-memory
 *     maintenance-window state. It must never touch `src/db.ts` (`pool.query`)
 *     or any other I/O — orchestrators poll this endpoint on a tight
 *     interval, and an accidental database call would cause restart loops
 *     during database outages, exactly when the probe is needed most.
 *   - Never cacheable: every response (including the 503 maintenance
 *     branch) carries `Cache-Control: no-store` so proxies and clients can
 *     never serve a stale liveness result and a recovered instance is
 *     observed immediately.
 */
healthzRouter.get('/healthz', (_req: Request, res: Response): void => {
  res.setHeader('Cache-Control', 'no-store');
  if (activeMaintenanceWindow.isEnabled) {
    res.status(503).json({ status: 'MAINTENANCE' });
    return;
  }
  res.status(200).json({ status: 'ok' });
});
