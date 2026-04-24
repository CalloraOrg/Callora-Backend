import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../middleware/ipAllowlist.js';
import { findUsers } from '../repositories/userRepository.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import { AppError } from '../errors/index.js';
import { logger } from '../logger.js';

const router = Router();

// Apply IP allowlist check before authentication
router.use(createAdminIpAllowlist());
router.use(adminAuth);

router.get('/users', async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query as Record<string, string>);
    const { users, total } = await findUsers({ limit, offset });

    logger.audit('LIST_USERS', res.locals.adminActor, { limit, offset, count: users.length, total });

    res.json(paginatedResponse(users, { total, limit, offset }));
  } catch (error) {
    logger.error('Failed to list users:', error);
    next(new AppError('Internal server error', 500));
  }
});

export default router;
