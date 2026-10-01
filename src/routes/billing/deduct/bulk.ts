import { Router, type Response, type NextFunction, type Request } from 'express';
import { z } from 'zod';
import { UnauthorizedError } from '../../../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../../../middleware/requireAuth.js';
import { validate } from '../../../middleware/validate.js';
import { getBillingService } from '../billingService.js';
import { logger } from '../../../logger.js';

const router = Router();

export interface BulkDeductItemResult {
  requestId: string;
  success: boolean;
  usageEventId?: string;
  stellarTxHash?: string;
  alreadyProcessed?: boolean;
  error?: string;
}

const bulkItemSchema = z.object({
  requestId: z.string().min(1, 'requestId is required'),
  apiId: z.string().min(1, 'apiId is required'),
  endpointId: z.string().min(1, 'endpointId is required'),
  apiKeyId: z.string().min(1, 'apiKeyId is required'),
  amountUsdc: z.string()
    .regex(/^\d+(\.\d{1,7})?$/, 'amountUsdc must be a positive decimal with at most 7 fractional digits')
    .refine((val) => Number(val) > 0, 'amountUsdc must be greater than zero'),
  idempotencyKey: z.string().optional(),
}).strict();

const bulkDeductSchema = z.object({
  items: z.array(bulkItemSchema)
    .min(1, 'At least one item is required')
    .max(100, 'Batch size limit of 100 items exceeded'),
}).strict();

/**
 * POST /api/billing/deduct/bulk
 *
 * Performs batch billing deductions (up to 100 requests) sequentially.
 *
 * Request body structure:
 * {
 *   "items": [
 *     {
 *       "requestId": "req_1",
 *       "apiId": "api_1",
 *       "endpointId": "ep_1",
 *       "apiKeyId": "key_1",
 *       "amountUsdc": "0.0100000",
 *       "idempotencyKey": "idem_1"
 *     }
 *   ]
 * }
 */
router.post(
  '/',
  requireAuth,
  validate({ body: bulkDeductSchema }),
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction
  ): Promise<void> => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const { items } = req.body as z.infer<typeof bulkDeductSchema>;
      const billingService = getBillingService(req);
      const results: BulkDeductItemResult[] = [];

      for (const item of items) {
        try {
          const result = await billingService.deduct({
            requestId: item.requestId,
            userId: user.id,
            apiId: item.apiId,
            endpointId: item.endpointId,
            apiKeyId: item.apiKeyId,
            amountUsdc: item.amountUsdc,
            idempotencyKey: item.idempotencyKey,
          });

          if (result.success) {
            results.push({
              requestId: item.requestId,
              success: true,
              usageEventId: result.usageEventId,
              stellarTxHash: result.stellarTxHash,
              alreadyProcessed: result.alreadyProcessed,
            });
          } else {
            results.push({
              requestId: item.requestId,
              success: false,
              error: result.error ?? 'Deduction failed',
            });
          }
        } catch (itemError) {
          logger.error(`Error processing bulk deduct item ${item.requestId}:`, itemError);
          results.push({
            requestId: item.requestId,
            success: false,
            error: itemError instanceof Error ? itemError.message : 'Unknown error',
          });
        }
      }

      res.status(200).json({ results });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
