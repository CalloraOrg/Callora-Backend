/**
 * Quota self-service router — developer-facing endpoints.
 *
 * Mounted at /api/quota/requests in app.ts.
 *
 * Routes:
 *   POST   /api/quota/requests         – Submit a new quota increase request
 *   GET    /api/quota/requests         – List the caller's own quota requests
 *   GET    /api/quota/requests/:id     – Fetch a single quota request by ID
 *
 * Security: all routes require user authentication (JWT Bearer or x-user-id).
 * Users can only see their own requests; cross-user access returns 404.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { bodyValidator } from '../../middleware/validate.js';
import { correlationMiddleware } from '../../middleware/correlation.js';
import { quotaRequestSchema } from '../../validators/quotaRequest.js';
import {
  createQuotaRequest,
  getQuotaRequest,
  listQuotaRequests,
} from '../../services/quotaService.js';
import { logger } from '../../logger.js';
import { NotFoundError, UnauthorizedError } from '../../errors/index.js';
import { withSpan } from '../../otel/spans.js';

const router = Router();

// Propagate X-Correlation-Id across every quota self-service request.
router.use(correlationMiddleware);

/**
 * POST /api/quota/requests
 *
 * Submit a new quota increase request. The request is created in `pending`
 * state and queued for admin review.
 *
 * Body: { requested_tier, reason, requested_overrides? }
 * Response 201: { data: QuotaRequest }
 */
router.post(
  '/',
  requireAuth,
  bodyValidator(quotaRequestSchema),
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      await withSpan({ name: 'POST /api/quota/requests', req }, async () => {
        const user = res.locals.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }

        const request = await createQuotaRequest({
          developerId: user.id,
          requestedTier: req.body.requested_tier,
          reason: req.body.reason,
          requestedOverrides: req.body.requested_overrides
            ? {
                monthlyCallLimit: req.body.requested_overrides.monthly_call_limit,
                rateLimitMaxRequests: req.body.requested_overrides.rate_limit_max_requests,
              }
            : undefined,
        });

        const correlationId = (req as Request & { correlationId?: string }).correlationId;

        logger.info('Quota request created via self-service', {
          quotaRequestId: request.id,
          developerId: user.id,
          requestedTier: request.requestedTier,
          correlationId: (req as Request & { correlationId?: string }).correlationId,
        });

        res.status(201).json({ data: request, correlationId });
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/quota/requests
 *
 * Returns the authenticated developer's own quota requests.
 * Optionally filtered by ?status=pending|approved|rejected.
 *
 * Response 200: { data: QuotaRequest[] }
 */
router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      await withSpan({ name: 'GET /api/quota/requests', req }, async () => {
        const user = res.locals.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }

        const correlationId = (req as Request & { correlationId?: string }).correlationId;

        // Optional status filter — validate the enum value at the boundary
        const statusParam =
          typeof req.query.status === 'string' ? req.query.status : undefined;
        if (
          statusParam !== undefined &&
          !['pending', 'approved', 'rejected'].includes(statusParam)
        ) {
          res.status(400).json({
            code: 'VALIDATION_ERROR',
            message: 'status must be one of: pending, approved, rejected',
            requestId: req.id ?? 'unknown',
            correlationId,
          });
          return;
        }

        // Fetch all requests for the caller's developer ID, then filter by
        // status in the service layer so the existing store interface is reused.
        const allRequests = await listQuotaRequests(
          statusParam
            ? { status: statusParam as 'pending' | 'approved' | 'rejected' }
            : undefined,
        );

        // Ownership guard: only return requests belonging to the caller
        const ownRequests = allRequests.filter((r) => r.developerId === user.id);

        logger.info('Quota requests listed', {
          developerId: user.id,
          count: ownRequests.length,
          statusFilter: statusParam,
          correlationId: (req as Request & { correlationId?: string }).correlationId,
        });

        res.json({ data: ownRequests, correlationId });
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/quota/requests/:id
 *
 * Returns a single quota request by ID. The caller must own the request;
 * a request belonging to another developer is returned as 404 to avoid
 * leaking resource IDs.
 *
 * Response 200: { data: QuotaRequest }
 * Response 404: request not found or not owned by caller
 */
router.get(
  '/:id',
  requireAuth,
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      await withSpan({ name: 'GET /api/quota/requests/:id', req }, async () => {
        const user = res.locals.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }

        const correlationId = (req as Request & { correlationId?: string }).correlationId;

        const request = await getQuotaRequest(req.params.id);

        // Ownership guard: treat another developer's request as 404 to avoid
        // leaking whether a given ID exists at all.
        if (request.developerId !== user.id) {
          throw new NotFoundError('Quota request not found', 'QUOTA_REQUEST_NOT_FOUND');
        }

        logger.info('Quota request fetched', {
          quotaRequestId: request.id,
          developerId: user.id,
          correlationId: (req as Request & { correlationId?: string }).correlationId,
        });

        res.json({ data: request, correlationId });
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
