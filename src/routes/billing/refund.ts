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
 *   The `Idempotency-Key` header is REQUIRED. The generic `idempotencyMiddleware`
 *   caches small responses per key and replays them (with an
 *   `Idempotent-Replayed: true` header). Responses over the cache cap are not
 *   cached, so a retry reaches the handler again. The grant therefore records a
 *   receipt per (scope, key) in the same SQLite transaction as the balance
 *   change; a same-key retry returns the stored result. See
 *   docs/billing-idempotency.md ("Refund grant receipts").
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import { bodyValidator } from '../../middleware/validate.js';
import { idempotencyMiddleware, type IdempotencyLease } from '../../middleware/idempotency.js';
import { logger } from '../../logger.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../../errors/index.js';
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

        const lease: IdempotencyLease | undefined = res.locals.idempotency;
        if (!lease) {
          next(new InternalServerError('Refund idempotency context is missing'));
          return;
        }

        const input = refundRequestSchema.parse(req.body) as RefundRequestInput;
        const credit = await creditsRepo.grant(input.developerId, input.amountUsdc, {
          scope: lease.scope,
          idempotencyKey: lease.idempotencyKey,
          requestHash: lease.requestHash,
        });

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
