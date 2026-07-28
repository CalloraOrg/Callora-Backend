import { Router } from 'express';
import { z } from 'zod';

import { AppError, InternalServerError } from '../../../errors/index.js';
import { getClientIp } from '../../../lib/clientIp.js';
import { logger } from '../../../logger.js';
import { validate } from '../../../middleware/validate.js';
import { KeySemaphore, sharedKeySemaphore } from '../../../utils/keySemaphore.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
const GRANTFOX_FWC26_CAMPAIGN = 'GrantFox FWC26';

const keyIdParamsSchema = z.object({
  keyId: z.string().min(1, 'keyId is required'),
});

export interface AdminKeyConcurrencyRouterDeps {
  keySemaphore: KeySemaphore;
}

/**
 * Creates routes for viewing per-API-key concurrency statistics.
 *
 * Authentication and IP allowlisting are supplied by the parent admin router.
 * The `KeySemaphore` instance is shared with the gateway/proxy middleware so
 * the concurrency counts reported here reflect live traffic.
 *
 * @example
 * // Active slot counts for all keys
 * GET /api/admin/keys/concurrency
 * // → { data: { keyCounts: { "key_abc": 2, "key_def": 1 }, totalActive: 3 } }
 *
 * // Active slot count for a specific key
 * GET /api/admin/keys/concurrency/:keyId
 * // → { data: { keyId: "key_abc", activeCount: 2, atLimit: false } }
 */
export function createAdminKeyConcurrencyRouter(
  deps: Partial<AdminKeyConcurrencyRouterDeps> = {},
): Router {
  const router = Router();
  const keySemaphore = deps.keySemaphore ?? sharedKeySemaphore;

  // GET /concurrency — snapshot of all active key concurrency counts
  router.get('/concurrency', (req, res, next) => {
    try {
      const keyCounts = keySemaphore.getCurrentActiveSlotCounts();
      const totalActive = keySemaphore.getTotalActiveSlotCount();

      logger.audit('READ_KEY_CONCURRENCY', res.locals.adminActor, {
        campaign: GRANTFOX_FWC26_CAMPAIGN,
        keyCount: Object.keys(keyCounts).length,
        totalActive,
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
      });

      res.json({
        data: {
          keyCounts,
          totalActive,
          maxConcurrencyPerKey: keySemaphore.maxConcurrency,
          campaign: GRANTFOX_FWC26_CAMPAIGN,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to read key concurrency stats', { error });
      next(new InternalServerError());
    }
  });

  // GET /concurrency/:keyId — active count for a specific key
  router.get(
    '/concurrency/:keyId',
    validate({ params: keyIdParamsSchema }),
    (req, res, next) => {
      try {
        const { keyId } = req.params;
        const activeCount = keySemaphore.getActiveSlotCount(keyId);
        const atLimit = keySemaphore.isAtLimit(keyId);

        logger.audit('READ_KEY_CONCURRENCY_DETAIL', res.locals.adminActor, {
          campaign: GRANTFOX_FWC26_CAMPAIGN,
          keyId,
          activeCount,
          atLimit,
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
        });

        res.json({
          data: {
            keyId,
            activeCount,
            atLimit,
            maxConcurrencyPerKey: keySemaphore.maxConcurrency,
            campaign: GRANTFOX_FWC26_CAMPAIGN,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }
        logger.error('Failed to read key concurrency detail', { error });
        next(new InternalServerError());
      }
    },
  );

  return router;
}

export default createAdminKeyConcurrencyRouter;
