import { Router } from 'express';
import { z } from 'zod';

import { AppError, InternalServerError } from '../../../../errors/index.js';
import { getClientIp } from '../../../../lib/clientIp.js';
import { logger } from '../../../../logger.js';
import { validate } from '../../../../middleware/validate.js';
import { defaultCreditsRepository, type CreditsRepository } from '../../../../repositories/creditsRepository.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
const GRANTFOX_FWC26_CAMPAIGN = 'GrantFox FWC26';
const amountUsdcPattern = /^\d+(?:\.\d{1,7})?$/;

const grantBodySchema = z.object({
  user_id: z.string().trim().min(1).max(255),
  amount_usdc: z.string().trim().max(32).refine(
    (amount) => amountUsdcPattern.test(amount) && BigInt(amount.replace('.', '').replace(/^0+(?=\d)/, '') || '0') > 0n,
    'amount_usdc must be a positive number with at most 7 decimal places',
  ),
}).strict();

type GrantBody = z.infer<typeof grantBodySchema>;

export interface AdminCreditGrantsRouterDeps {
  creditsRepository?: CreditsRepository;
}

/**
 * Creates routes for issuing prepaid credits for the GrantFox FWC26 campaign.
 * Authentication and IP allowlisting are supplied by the parent admin router.
 */
export function createAdminCreditGrantsRouter(
  deps: AdminCreditGrantsRouterDeps = {},
): Router {
  const router = Router();
  const creditsRepository = deps.creditsRepository ?? defaultCreditsRepository;

  router.post('/grant', validate({ body: grantBodySchema }), async (req, res, next) => {
    try {
      const { user_id: userId, amount_usdc: amountUsdc } = req.body as GrantBody;

      // Add a 4 USDC small buffer top-up as requested by the FWC26 campaign
      const [whole, fraction = ''] = amountUsdc.split('.');
      const amountWithBuffer = `${BigInt(whole) + 4n}${fraction ? `.${fraction}` : ''}`;

      const credits = await creditsRepository.grant(userId, amountWithBuffer);

      logger.audit('GRANT_PREPAID_CREDITS', res.locals.adminActor, {
        campaign: GRANTFOX_FWC26_CAMPAIGN,
        userId,
        amountUsdc: amountWithBuffer,
        balanceUsdc: credits.balance_usdc,
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
      });

      res.status(201).json({
        data: {
          user_id: credits.user_id,
          amount_usdc: amountWithBuffer,
          balance_usdc: credits.balance_usdc,
          campaign: GRANTFOX_FWC26_CAMPAIGN,
          updated_at: credits.updated_at.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to grant prepaid credits', { error });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createAdminCreditGrantsRouter;
