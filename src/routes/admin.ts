import { adminLogMiddleware } from '../middleware/adminLog.js';
import { Router, type Response } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../middleware/ipAllowlist.js';
import { findUsers } from '../repositories/userRepository.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import { getClientIp } from '../lib/clientIp.js';
import { AppError, InternalServerError, NotFoundError, BadRequestError } from '../errors/index.js';
import { logger } from '../logger.js';
import { createUsageStore, type UsageAdminStore } from '../services/usageStore.js';
import {
  listQuotaRequests,
  getQuotaRequest,
  approveQuotaRequest,
  rejectQuotaRequest,
} from '../services/quotaService.js';
import { createAdminWebhooksRouter } from './admin/webhooks.js';
import { createAdminApisRouter } from './admin/apis.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
const usageStore: UsageAdminStore = createUsageStore();

const router = Router();

// Apply IP allowlist check before authentication
router.use(createAdminIpAllowlist());
router.use(adminAuth);
router.use(adminLogMiddleware); // <--- Add this line here!
router.get('/users', async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query as Record<string, string>);
    const { users, total } = await findUsers({ limit, offset });

    const clientIp = getClientIp(req, TRUST_PROXY);
    const userAgent = req.get('User-Agent');
    const diff: Record<string, unknown> = {
      query: { ...req.query },
    };
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

router.get('/usage/:developerId', async (req, res: Response, next) => {
  try {
    const snapshot = await usageStore.getDeveloperUsageSnapshot(req.params.developerId);
    if (!snapshot) {
      next(new NotFoundError('Usage aggregate not found', 'USAGE_AGGREGATE_NOT_FOUND'));
      return;
    }

    logger.audit('READ_USAGE_AGGREGATE', res.locals.adminActor, {
      clientIp: getClientIp(req, TRUST_PROXY),
      userAgent: req.get('User-Agent'),
      developerId: req.params.developerId,
      totalEvents: snapshot.totalEvents,
    });

    res.json({ data: snapshot });
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error('Failed to read usage aggregate:', error);
    next(new InternalServerError());
  }
});

router.post('/usage/:developerId/reset', async (req, res, next) => {
  try {
    const priorValues = await usageStore.resetDeveloperUsage(req.params.developerId);
    if (!priorValues) {
      next(new NotFoundError('Usage aggregate not found', 'USAGE_AGGREGATE_NOT_FOUND'));
      return;
    }

    logger.audit('RESET_USAGE_AGGREGATE', res.locals.adminActor, {
      clientIp: getClientIp(req, TRUST_PROXY),
      userAgent: req.get('User-Agent'),
      developerId: req.params.developerId,
      priorValues,
    });

    res.json({
      data: {
        developerId: req.params.developerId,
        reset: true,
        priorValues,
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error('Failed to reset usage aggregate:', error);
    next(new InternalServerError());
  }
});

// ---------------------------------------------------------------------------
// Quota request management
// ---------------------------------------------------------------------------

router.get('/quota/requests', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !['pending', 'approved', 'rejected'].includes(status)) {
      next(new BadRequestError('status must be one of: pending, approved, rejected'));
      return;
    }

    const requests = await listQuotaRequests(status ? { status: status as 'pending' | 'approved' | 'rejected' } : undefined);

    logger.audit('LIST_QUOTA_REQUESTS', res.locals.adminActor, {
      clientIp: getClientIp(req, TRUST_PROXY),
      userAgent: req.get('User-Agent'),
      filter: { status },
      count: requests.length,
    });

    res.json({ data: requests });
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error('Failed to list quota requests:', error);
    next(new InternalServerError());
  }
});

router.post('/quota/requests/:id/approve', async (req, res, next) => {
  try {
    const adminNotes = typeof req.body.admin_notes === 'string' ? req.body.admin_notes : undefined;
    const request = await approveQuotaRequest(req.params.id, res.locals.adminActor, adminNotes);

    logger.audit('APPROVE_QUOTA_REQUEST', res.locals.adminActor, {
      clientIp: getClientIp(req, TRUST_PROXY),
      userAgent: req.get('User-Agent'),
      requestId: req.params.id,
      developerId: request.developerId,
    });

    res.json({ data: request });
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error('Failed to approve quota request:', error);
    next(new InternalServerError());
  }
});

router.post('/quota/requests/:id/reject', async (req, res, next) => {
  try {
    const adminNotes = typeof req.body.admin_notes === 'string' ? req.body.admin_notes : undefined;
    const request = await rejectQuotaRequest(req.params.id, res.locals.adminActor, adminNotes);

    logger.audit('REJECT_QUOTA_REQUEST', res.locals.adminActor, {
      clientIp: getClientIp(req, TRUST_PROXY),
      userAgent: req.get('User-Agent'),
      requestId: req.params.id,
      developerId: request.developerId,
    });

    res.json({ data: request });
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error('Failed to reject quota request:', error);
    next(new InternalServerError());
  }
});

// ---------------------------------------------------------------------------
// Webhook signing-key rotation + delivery monitoring
// Mounts:  POST /api/admin/webhooks/rotate-key
//          GET  /api/admin/webhooks/grace-window
//          GET  /api/admin/webhooks/monitor
// ---------------------------------------------------------------------------
router.use('/webhooks', createAdminWebhooksRouter());

// ---------------------------------------------------------------------------
// API soft-delete and restore
// Mounts:  DELETE /api/admin/apis/:id
//          POST   /api/admin/apis/:id/restore
// ---------------------------------------------------------------------------
router.use('/apis', createAdminApisRouter());

export default router;
