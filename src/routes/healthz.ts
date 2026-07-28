import { Router, Request, Response } from 'express';
import { activeMaintenanceWindow } from './admin/maintenance.js';

export const healthzRouter = Router();

healthzRouter.get('/healthz', (_req: Request, res: Response): void => {
  if (activeMaintenanceWindow.isEnabled) {
    res.status(503).json({ status: 'MAINTENANCE' });
    return;
  }
  res.status(200).json({ status: 'ok' });
});
