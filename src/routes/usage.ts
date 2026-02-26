import { Router } from 'express';
import type { UsageResponse } from '../types/index.js';

const router = Router();

router.get('/', (_req, res) => {
  const response: UsageResponse = { calls: 0, period: 'current' };
  res.json(response);
});

export default router;
