import { Router } from 'express';
import type { HealthResponse } from '../types/index.js';

const router = Router();

router.get('/', (_req, res) => {
  const response: HealthResponse = { status: 'ok', service: 'callora-backend' };
  res.json(response);
});

export default router;
