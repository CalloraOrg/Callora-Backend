import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { BadRequestError, InternalServerError, UnauthorizedError } from '../../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { logger } from '../../logger.js';
import { calloraEvents } from '../../events/event.emitter.js';
import {
  calculateFeeQuote,
  createFeeBumpTransaction,
  FeeBumperConfigError,
  FeeBumperInvalidTransactionError,
  FeeBumperSigningError,
} from '../../services/feeBumper.js';

export function createFeeAbstractionRouter(): Router {
  const router = Router();

  const quoteBodySchema = z.object({
    innerXdr: z.string().min(1, 'innerXdr is required'),
  });

  const executeBodySchema = z.object({
    innerXdr: z.string().min(1, 'innerXdr is required'),
    appTokenPaymentTxId: z.string().min(1, 'appTokenPaymentTxId is required'),
  });

  /**
   * POST /api/billing/fee-abstraction/quote
   * Returns estimated XLM fee and equivalent app-token amount for wrapping the given inner transaction.
   */
  router.post(
    '/quote',
    requireAuth,
    validate({ body: quoteBodySchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ): Promise<void> => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { innerXdr } = req.body as z.infer<typeof quoteBodySchema>;

        logger.info('Fee-abstraction quote requested', { userId: user.id });

        const quote = calculateFeeQuote(innerXdr);

        res.status(200).json({
          baseFeeStroops: quote.baseFeeStroops,
          feeBumpFeeStroops: quote.feeBumpFeeStroops,
          feeBumpFeeXlm: quote.feeBumpFeeXlm,
          appTokenAmount: quote.appTokenAmount,
          network: quote.network,
        });
      } catch (err) {
        if (err instanceof FeeBumperInvalidTransactionError) {
          next(new BadRequestError(err.message, 'VALIDATION_ERROR'));
          return;
        }
        next(err);
      }
    },
  );

  /**
   * POST /api/billing/fee-abstraction
   * Validates the request, accepts the app-token payment, and performs server-side fee bumping.
   */
  router.post(
    '/',
    requireAuth,
    validate({ body: executeBodySchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ): Promise<void> => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { innerXdr, appTokenPaymentTxId } = req.body as z.infer<typeof executeBodySchema>;

        logger.info('Fee-abstraction execution requested', {
          userId: user.id,
          appTokenPaymentTxId,
        });

        const result = createFeeBumpTransaction(innerXdr);

        logger.info('Fee-bump transaction created', {
          userId: user.id,
          feeAccount: result.feeAccountPublicKey,
          feeStroops: result.feeStroops,
        });

        // Emit fee_abstraction.executed event
        calloraEvents.emit('fee_abstraction.executed', user.id, {
          userId: user.id,
          appTokenPaymentTxId,
          feeAccountPublicKey: result.feeAccountPublicKey,
          feeStroops: result.feeStroops,
          feeBumpXdr: result.feeBumpXdr,
        });

        res.status(200).json({
          feeBumpXdr: result.feeBumpXdr,
          feeAccountPublicKey: result.feeAccountPublicKey,
          feeStroops: result.feeStroops,
        });
      } catch (err) {
        if (err instanceof FeeBumperInvalidTransactionError) {
          next(new BadRequestError(err.message, 'VALIDATION_ERROR'));
          return;
        }
        if (err instanceof FeeBumperConfigError) {
          logger.error('Fee-bumper configuration error', err);
          next(new InternalServerError('Fee-bumper service is not configured'));
          return;
        }
        if (err instanceof FeeBumperSigningError) {
          logger.error('Fee-bumper signing error', err);
          next(new InternalServerError('Fee-bumper signing failed'));
          return;
        }
        next(err);
      }
    },
  );

  return router;
}

export default createFeeAbstractionRouter;
