/**
 * src/routes/billing/refund.ts
 *
 * POST / — admin issues a refund by crediting a developer's prepaid USDC
 * balance (backed by `creditsRepository`, the same store `GET /billing/credits`
 * reads from).
 *
 * RBAC:
 *   Admin (adminAuth): POST / — issue a refund
 *
 * Idempotency:
 *   Refunds move money and this route has no ledger table of its own to
 *   detect duplicate submissions (unlike /billing/deduct, which dedupes via
 *   the `usage_events.request_id` unique constraint). The `Idempotency-Key`
 *   header is therefore REQUIRED — the generic `idempotencyMiddleware`
 *   caches the first response per key and replays it (with an
 *   `Idempotent-Replayed: true` header) for retries, instead of crediting
 *   the balance twice. See docs/billing-refund-idempotency.md.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import { bodyValidator } from '../../middleware/validate.js';
import { idempotencyMiddleware } from '../../middleware/idempotency.js';
import { logger } from '../../logger.js';
import { BadRequestError, UnauthorizedError } from '../../errors/index.js';
import {
  defaultCreditsRepository,
  type CreditsRepository,
} from '../../repositories/creditsRepository.js';

export interface RefundRouterDeps {
  creditsRepository?: CreditsRepository;
}

export const refundRequestSchema = z.object({
  developerId: z.string().min(1, 'developerId is required'),
  amountUsdc: z
    .string()
    .regex(
      /^\d+(\.\d{1,7})?$/,
      'amountUsdc must be a positive number with at most 7 decimal places',
    )
    .refine((value) => Number(value) > 0, 'amountUsdc must be greater than zero'),
  reason: z.string().min(1, 'reason is required').max(1000),
  requestId: z.string().min(1).max(255).optional(),
});

export type RefundRequestInput = z.infer<typeof refundRequestSchema>;

// idempotencyMiddleware declares an optional 4th `opts` parameter, giving it
// an arity of 4. Express treats any 4-arg middleware function as an error
// handler (function(err, req, res, next)), so registering it directly would
// cause thrown errors to be misrouted into it instead of the real error
// handler. Wrap it to a 3-arg function so Express dispatches it normally
// (same fix applied in billing/deduct.ts).
const idempotencyHandler = (req: Request, res: Response, next: NextFunction) =>
  idempotencyMiddleware(req, res, next);

function requireIdempotencyKeyHeader(req: Request, _res: Response, next: NextFunction): void {
  const key = req.header('idempotency-key');
  if (!key || key.trim() === '') {
    next(new BadRequestError('Idempotency-Key header is required for refund requests'));
    return;
  }
  next();
}

export function createRefundRouter(deps: RefundRouterDeps = {}): Router {
  const router = Router();
  const creditsRepo = deps.creditsRepository ?? defaultCreditsRepository;

  router.post(
    '/',
    adminAuth,
    bodyValidator(refundRequestSchema),
    requireIdempotencyKeyHeader,
    idempotencyHandler,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const adminActor = (res.locals as { adminActor?: string }).adminActor;
        if (!adminActor) {
          next(new UnauthorizedError('Admin authentication required'));
          return;
        }

        const input = refundRequestSchema.parse(req.body) as RefundRequestInput;
        const credit = await creditsRepo.grant(input.developerId, input.amountUsdc);

        logger.audit('REFUND_ISSUED', adminActor, {
          developerId: input.developerId,
          amountUsdc: input.amountUsdc,
          reason: input.reason,
          requestId: input.requestId,
          balanceUsdc: credit.balance_usdc,
        });

        res.status(200).json({
          success: true,
          developerId: input.developerId,
          amountUsdc: input.amountUsdc,
          balanceUsdc: credit.balance_usdc,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createRefundRouter();
