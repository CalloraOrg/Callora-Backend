import { Router } from 'express';
import type { HealthResponse } from '../types/index.js';
import { pool } from '../db.js';
import { config } from '../config/index.js';
import { performHealthCheck } from '../services/healthCheck.js';

const router = Router();

router.get('/', async (_req, res) => {
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
