import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { findUsers } from '../repositories/userRepository.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

router.use(adminAuth);

router.get('/users', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    const { users, total } = await findUsers({ limit, offset });
    res.json(paginatedResponse(users, { total, limit, offset }));
  } catch (error) {
    console.error('Failed to list users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
