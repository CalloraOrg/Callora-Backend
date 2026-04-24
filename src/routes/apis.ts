import { Router } from 'express';
import type { ApisResponse } from '../types/index.js';

const router = Router();

router.get('/', (_req, res) => {
  const response: ApisResponse = { apis: [] };
  res.json(response);
});

export default router;
