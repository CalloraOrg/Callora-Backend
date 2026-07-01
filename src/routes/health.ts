import { Router } from 'express';
import type { HealthResponse } from '../types/index.js';
import { pool } from '../db.js';
import { config } from '../config/index.js';
import { performHealthCheck } from '../services/healthCheck.js';
import { activeMaintenanceWindow } from './admin/maintenance.js'; // <-- Added maintenance state import

const router = Router();

router.get('/', async (_req, res) => {
  const now = new Date();

  // 1. Evaluate if the current system timestamp falls exactly within the active maintenance window
  const isCurrentlyUnderMaintenance = 
    activeMaintenanceWindow.isEnabled &&
    activeMaintenanceWindow.startTime &&
    activeMaintenanceWindow.endTime &&
    now >= new Date(activeMaintenanceWindow.startTime) &&
    now <= new Date(activeMaintenanceWindow.endTime);

  if (isCurrentlyUnderMaintenance) {
    res.status(503).json({
      status: 'MAINTENANCE',
      version: config.version,
      timestamp: now.toISOString(),
      details: {
        reason: activeMaintenanceWindow.reason,
        expiresAt: activeMaintenanceWindow.endTime,
      }
    });
    return;
  }

  // 2. Fall back to your standard runtime health checks if not under maintenance
  const response: HealthResponse = await performHealthCheck({
    version: config.version,
    database: {
      pool,
      timeout: config.database.timeout,
    },
    sorobanRpc: config.sorobanRpc,
    horizon: config.horizon,
  });

  const statusCode = response.status === 'down' ? 503 : 200;
  res.status(statusCode).json(response);
});

export default router;