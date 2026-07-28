import { adminLogMiddleware } from '../middleware/adminLog.js';
import { etagMiddleware } from '../middleware/etag.js';
import { Router, type Response } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../middleware/ipAllowlist.js';
import { findUsers } from '../repositories/userRepository.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import { getClientIp } from '../lib/clientIp.js';
import { AppError, InternalServerError, NotFoundError } from '../errors/index.js';
import { logger } from '../logger.js';
import { createUsageStore, type UsageAdminStore } from '../services/usageStore.js';
import {
  listQuotaRequests,
  approveQuotaRequest,
  rejectQuotaRequest,
} from '../services/quotaService.js';
import { validate } from '../middleware/validate.js';
import {
  developerIdParamsSchema,
  quotaRequestsQuerySchema,
  quotaRequestIdParamsSchema,
  quotaRequestActionBodySchema,
} from '../validators/admin.js';
import { createAdminQuotaBulkRouter } from './admin/quotas/bulk.js';
import { createAdminWebhooksRouter } from './admin/webhooks.js';
import { createAdminApisRouter } from './admin/apis.js';
import { createAdminHealthProbesRouter } from './admin/health/probes.js';
import { createAdminCreditGrantsRouter } from './admin/billing/credits/grant.js';
import { createAdminUsageExportRouter } from './admin/usage/export.js';
import { createAdminKeyConcurrencyRouter } from './admin/keys/concurrency.js';
import { createAdminAuditRouter } from './admin/audit.js';
import { createMaintenanceBannerRouter } from './admin/maintenance/banner.js';
import { createAdminDevMetricsRouter } from './admin/metrics.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
const usageStore: UsageAdminStore = createUsageStore();

const router = Router();

// Apply IP allowlist check before authentication
router.use(createAdminIpAllowlist());
router.use(adminAuth);
router.use(adminLogMiddleware);
router.use(etagMiddleware);
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

router.use('/usage/export', createAdminUsageExportRouter());

/**
 * GET /api/admin/usage/:developerId
 *
 * Returns a redacted usage aggregate snapshot for the given developer.
 * The `developerId` route parameter must be a non-empty string (validated
 * by developerIdParamsSchema).  Returns 404 when no snapshot exists.
 */
router.get(
  '/usage/:developerId',
  validate({ params: developerIdParamsSchema }),
  async (req, res: Response, next) => {
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
  },
);

/**
 * POST /api/admin/usage/:developerId/reset
 *
 * Clears the in-memory usage aggregate for the given developer and returns
 * the prior values for audit purposes.  Returns 404 when no aggregate exists.
 */
router.post(
  '/usage/:developerId/reset',
  validate({ params: developerIdParamsSchema }),
  async (req, res, next) => {
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
  },
);

// ---------------------------------------------------------------------------
// Quota request management
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/quota/requests
 *
 * Lists quota upgrade requests.  Accepts an optional `status` query parameter
 * constrained to 'pending' | 'approved' | 'rejected'.  Any other value is
 * rejected with a structured HTTP 400 before hitting the database.
 */
router.get(
  '/quota/requests',
  validate({ query: quotaRequestsQuerySchema }),
  async (req, res, next) => {
    try {
      const { status } = req.query as { status?: 'pending' | 'approved' | 'rejected' };

      const requests = await listQuotaRequests(status ? { status } : undefined);

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
  },
);

/**
 * POST /api/admin/quota/requests/:id/approve
 *
 * Approves a quota upgrade request.  The `id` route parameter must be a
 * non-empty string.  The optional `admin_notes` body field is capped at
 * 2 000 characters.
 */
router.post(
  '/quota/requests/:id/approve',
  validate({ params: quotaRequestIdParamsSchema, body: quotaRequestActionBodySchema }),
  async (req, res, next) => {
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
  },
);

/**
 * POST /api/admin/quota/requests/:id/reject
 *
 * Rejects a quota upgrade request.  The `id` route parameter must be a
 * non-empty string.  The optional `admin_notes` body field is capped at
 * 2 000 characters.
 */
router.post(
  '/quota/requests/:id/reject',
  validate({ params: quotaRequestIdParamsSchema, body: quotaRequestActionBodySchema }),
  async (req, res, next) => {
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
  },
);

router.use('/quota/requests', createAdminQuotaBulkRouter());

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

// ---------------------------------------------------------------------------
// Admin health probes (per-component)
// Mounts:  GET /api/admin/health/probes
//          GET /api/admin/health/probes/:component
// ---------------------------------------------------------------------------
router.use('/health/probes', createAdminHealthProbesRouter());

// ---------------------------------------------------------------------------
// GrantFox FWC26 prepaid-credit grants
// Mount: POST /api/admin/billing/credits/grant
// ---------------------------------------------------------------------------
router.use('/billing/credits', createAdminCreditGrantsRouter());

// ---------------------------------------------------------------------------
// Admin quota bulk updates
// Mount: POST /api/admin/quotas/bulk-update
// ---------------------------------------------------------------------------
router.use('/quotas', createAdminQuotaBulkRouter());

// ---------------------------------------------------------------------------
// GrantFox FWC26 per-key concurrency stats
// Mounts: GET /api/admin/keys/concurrency
//         GET /api/admin/keys/concurrency/:keyId
// ---------------------------------------------------------------------------
router.use('/keys', createAdminKeyConcurrencyRouter());

// ---------------------------------------------------------------------------
// GrantFox FWC26 per-developer billing-concurrency stats
// Mounts: GET /api/admin/metrics/concurrency
//         GET /api/admin/metrics/concurrency/:developerId
// ---------------------------------------------------------------------------
router.use('/metrics', createAdminDevMetricsRouter());

// ---------------------------------------------------------------------------
// Admin audit-log listing
// Mounts: GET /api/admin/audit
// ---------------------------------------------------------------------------
router.use('/audit', createAdminAuditRouter());

// ---------------------------------------------------------------------------
// Maintenance banner
// Mount: POST /api/admin/maintenance/banner
// ---------------------------------------------------------------------------
router.use('/maintenance/banner', createMaintenanceBannerRouter());

export default router;
