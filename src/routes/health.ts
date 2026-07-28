import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config/index.js';
import { createDbHealthRouter } from './health/db.js';
import { createHealthDependencyRouter } from './health/health.js';

const router = Router();

// DB pool stats endpoint: GET /api/health/db
router.use('/db', createDbHealthRouter());

// Dependency-level health probe: GET /api/health/health
router.use(
  '/health',
  createHealthDependencyRouter(
    {
      version: config.version,
      database: { pool, timeout: config.database.timeout },
      sorobanRpc: config.sorobanRpc,
      horizon: config.horizon,
    },
    config.version,
  ),
);

export default router;
