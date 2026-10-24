import { Router, type Response, type NextFunction, type Request } from 'express';
import { z } from 'zod';
import { UnauthorizedError, PaymentRequiredError, InternalServerError } from '../../../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../../../middleware/requireAuth.js';
import { validate } from '../../../middleware/validate.js';
import { idempotencyMiddleware } from '../../../middleware/idempotency.js';
import { errorEnvelope } from '../../../lib/envelope.js';
import { getBillingService } from '../billingService.js';

const router = Router();

const bulkItemSchema = z.object({
  requestId: z.string().min(1, 'requestId is required'),
  apiId: z.string().min(1, 'apiId is required'),
  endpointId: z.string().min(1, 'endpointId is required'),
  apiKeyId: z.string().min(1, 'apiKeyId is required'),
  amountUsdc: z.string()
    .regex(/^\d+(\.\d{1,7})?$/, 'amountUsdc must be a positive decimal with at most 7 fractional digits')
    .refine((val) => Number(val) > 0, 'amountUsdc must be greater than zero'),
}).strict();

const bulkDeductSchema = z.object({
  items: z.array(bulkItemSchema)
    .min(1, 'At least one item is required')
    .max(100, 'Batch size limit of 100 items exceeded')
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item.requestId)) {
          context.addIssue({ code: 'custom', path: [index, 'requestId'], message: 'DUPLICATE_REQUEST_ID' });
        }
        seen.add(item.requestId);
      });
    }),
  idempotencyKey: z.string().optional(),
}).strict();

const idempotencyHandler = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction,
) => idempotencyMiddleware(req, res, next);

const rejectDuplicateRequestIds = (req: Request, res: Response, next: NextFunction): void => {
  const items = (req.body as { items?: Array<{ requestId?: unknown }> } | undefined)?.items;
  if (!Array.isArray(items)) {
    next();
    return;
  }
  const requestIds = items.map((item) => item?.requestId).filter((id): id is string => typeof id === 'string');
  if (new Set(requestIds).size !== requestIds.length) {
    res.status(400).json(errorEnvelope('DUPLICATE_REQUEST_ID', 'requestId values must be unique within a batch', req.id ?? ''));
    return;
  }
  next();
};

router.post(
  '/',
  requireAuth,
  idempotencyHandler,
  rejectDuplicateRequestIds,
  validate({ body: bulkDeductSchema }),
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction): Promise<void> => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const { items } = req.body as z.infer<typeof bulkDeductSchema>;
      const idempotencyKey = req.get('Idempotency-Key') ??
        (req.body as z.infer<typeof bulkDeductSchema>).idempotencyKey;
      const result = await getBillingService(req).deductBulk(
        items.map((item) => ({ ...item, userId: user.id })),
        idempotencyKey,
      );

      if (!result.success) {
        if (result.error?.toLowerCase().includes('insufficient balance')) {
          next(new PaymentRequiredError(result.error, 'INSUFFICIENT_BALANCE'));
          return;
        }
        if (result.results.some((entry) => entry.conflict)) {
          res.status(409).json(errorEnvelope('BILLING_REQUEST_ID_CONFLICT', 'requestId already used for a different deduction', req.id ?? '', {
            results: result.results.map((entry) => ({
              requestId: entry.requestId,
              success: !entry.conflict,
              ...(entry.conflict ? { conflict: true } : {}),
            })),
          }));
          return;
        }
        if (result.results.some((entry) => entry.reconciliationRequired)) {
          res.status(409).json(errorEnvelope('RECONCILIATION_REQUIRED', 'Billing deduction requires reconciliation', req.id ?? '', {
            reconciliationRequired: true,
            results: result.results,
          }));
          return;
        }
        next(new InternalServerError(result.error ?? 'Bulk billing deduction failed', 'BILLING_DEDUCTION_FAILED'));
        return;
      }

      res.status(200).json({
        success: true,
        entryCount: result.entryCount,
        deductedCount: result.deductedCount,
        totalDeductedAmountUsdc: result.totalDeductedAmountUsdc,
        stellarTxHash: result.stellarTxHash,
        results: result.results.map((entry) => ({
          requestId: entry.requestId,
          success: true,
          usageEventId: entry.usageEventId,
          stellarTxHash: entry.stellarTxHash,
          alreadyProcessed: entry.alreadyProcessed,
          deductionApplied: entry.deductionApplied,
          reconciliationRequired: entry.reconciliationRequired,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
