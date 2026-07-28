import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db as defaultDb, schema } from '../../../db/index.js';
import { logger } from '../../../logger.js';
import { validate } from '../../../middleware/validate.js';
import { getClientIp } from '../../../lib/clientIp.js';
import { AppError, InternalServerError, NotFoundError } from '../../../errors/index.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const quotaBulkItemSchema = z.object({
  developer_id: z.string().trim().min(1, 'developer_id is required').max(255, 'developer_id must not exceed 255 characters'),
  plan_tier: z.enum(['free', 'pro', 'enterprise'], {
    message: 'plan_tier must be one of: free, pro, enterprise',
  }),
  monthly_call_limit: z.number().int().positive().optional(),
  rate_limit_max_requests: z.number().int().positive().optional(),
}).strict();

const quotaBulkUpdateSchema = z.object({
  items: z.array(quotaBulkItemSchema)
    .min(1, 'At least one item is required')
    .max(100, 'Batch size limit of 100 items exceeded'),
}).strict();

export interface AdminQuotaBulkRouterDeps {
  db?: typeof defaultDb;
}

export function createAdminQuotaBulkRouter(deps: AdminQuotaBulkRouterDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? defaultDb;

  router.post(
    '/bulk-update',
    validate({ body: quotaBulkUpdateSchema }),
    async (req, res, next) => {
      try {
        const { items } = req.body as z.infer<typeof quotaBulkUpdateSchema>;

        await db.transaction(async (tx) => {
          for (const item of items) {
            const rows = await tx
              .select({ plan_overrides: schema.developers.plan_overrides })
              .from(schema.developers)
              .where(eq(schema.developers.user_id, item.developer_id))
              .limit(1);

            const developer = rows[0];
            if (!developer) {
              throw new NotFoundError(`Developer not found: ${item.developer_id}`);
            }

            const currentOverrides = developer.plan_overrides
              ? JSON.parse(developer.plan_overrides)
              : {};

            const mergedOverrides = {
              ...currentOverrides,
              plan_tier: item.plan_tier,
              ...(item.monthly_call_limit !== undefined
                ? { monthly_call_limit: item.monthly_call_limit }
                : {}),
              ...(item.rate_limit_max_requests !== undefined
                ? { rate_limit_max_requests: item.rate_limit_max_requests }
                : {}),
              updated_at: new Date().toISOString(),
            };

            await tx
              .update(schema.developers)
              .set({ plan_overrides: JSON.stringify(mergedOverrides) })
              .where(eq(schema.developers.user_id, item.developer_id));
          }
        });

        logger.audit('BULK_UPDATE_QUOTAS', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
          requestedItems: items.length,
          developerIds: items.map((item) => item.developer_id),
        });

        res.status(200).json({
          data: {
            updated: items.length,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }

        logger.error('Failed to bulk update quotas:', error);
        next(new InternalServerError());
      }
    },
  );

  return router;
}

export default createAdminQuotaBulkRouter;
