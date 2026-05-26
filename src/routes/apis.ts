import { Router } from 'express';
import type { ApisResponse } from '../types/index.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

router.get('/', (req, res) => {
  parsePagination(req.query as Record<string, string>);
  const response: ApisResponse = { apis: [] };
  res.json(response);
});

export default router;
