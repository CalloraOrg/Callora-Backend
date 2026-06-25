import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../middleware/ipAllowlist.js';
import { findUsers } from '../repositories/userRepository.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import { getClientIp } from '../lib/clientIp.js';
import { AppError, InternalServerError } from '../errors/index.js';
import { logger } from '../logger.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const router = Router();

// Apply IP allowlist check before authentication
router.use(createAdminIpAllowlist());
router.use(adminAuth);

router.get('/users', async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query as Record<string, string>);
    const { users, total } = await findUsers({ limit, offset });

    const clientIp = getClientIp(req, TRUST_PROXY);
    const userAgent = req.get('User-Agent');
    const diff: Record<string, unknown> = {
      query: { ...req.query },
    };
    // Include request body for state-changing methods
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body && typeof req.body === 'object') {
      diff.body = req.body;
    }

    logger.audit('LIST_USERS', res.locals.adminActor, {
      clientIp,
      userAgent,
      diff,
      limit,
      offset,
      count: users.length,
      total,
    });

    res.json(paginatedResponse(users, { total, limit, offset }));
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error('Failed to list users:', error);
    next(new InternalServerError());
  }
});

export default router;
