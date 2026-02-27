import { Router } from 'express';
import type { HealthResponse } from '../types/index.js';
import { checkDbHealth } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  const db = await checkDbHealth();

  const response: HealthResponse = {
    status: db.ok ? 'ok' : 'degraded',
    service: 'callora-backend',
    db: {
      status: db.ok ? 'ok' : 'error',
      ...(db.ok ? {} : { error: db.error }),
    },
  };

  res.json(response);
});

export default router;
