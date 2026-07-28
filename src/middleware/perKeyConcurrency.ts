import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { KeySemaphore, sharedKeySemaphore } from '../utils/keySemaphore.js';

export interface PerKeyConcurrencyOptions {
  /** Maximum concurrent in-flight requests per API key. */
  maxConcurrent?: number;
  /** Semaphore instance to acquire slots on (defaults to the shared singleton). */
  semaphore?: KeySemaphore;
}

/**
 * Resolves the API key identity used to bucket concurrency.
 *
 * `req.apiKeyRecord` is populated by the gateway API-key auth middleware, so
 * this must run after it. The record id — not the raw key value — is used so
 * that secrets never reach the admin stats endpoint or the logs.
 */
function resolveKeyId(req: Request): string | undefined {
  const record = req.apiKeyRecord as { id?: unknown } | undefined;
  const id = record?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Express middleware that tracks — and optionally caps — the number of
 * concurrent in-flight gateway requests per API key.
 *
 * Its primary purpose is observability: holding a slot for the lifetime of
 * each request is what makes `GET /api/admin/keys/concurrency` report real
 * traffic instead of zeroes. Because the default ceiling
 * (`KEY_MAX_CONCURRENCY_PER_KEY`) is generous, enforcement is effectively
 * opt-in — operators lower it to turn the same signal into a limit.
 *
 * When a key is at its limit, further requests fast-fail with HTTP 429 rather
 * than queueing, so callers get an immediate back-off signal. This mirrors
 * {@link createPerDevConcurrencyMiddleware}, which does the same per developer
 * on the REST surface.
 *
 * Requests without an authenticated API key pass through untracked; the auth
 * middleware is responsible for rejecting them.
 *
 * @example
 * // Mount after the gateway auth middleware so req.apiKeyRecord is populated:
 * router.all('/:apiSlugOrId/*', authMiddleware, perKeyConcurrency, handleProxy);
 */
export function createPerKeyConcurrencyMiddleware(
  options: PerKeyConcurrencyOptions = {},
): RequestHandler {
  const semaphore = options.semaphore ?? sharedKeySemaphore;
  const maxConcurrent = options.maxConcurrent ?? config.keyConcurrency.maxPerKey;

  return (req: Request, res: Response, next: NextFunction): void => {
    const keyId = resolveKeyId(req);
    if (!keyId) {
      // No API key identity — pass through (auth middleware will reject).
      next();
      return;
    }

    if (semaphore.getActiveSlotCount(keyId) >= maxConcurrent) {
      const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';
      logger.warn('[perKeyConcurrency] key at concurrency limit', {
        keyId,
        maxConcurrent,
        requestId,
      });
      res.status(429).json({
        code: 'TOO_MANY_REQUESTS',
        message: 'Concurrency limit reached for this API key. Please retry your request.',
        requestId,
      });
      return;
    }

    // Acquire a slot and hold it until the response settles. This is
    // non-blocking here because we only reach this point when capacity is
    // available — withSlot queues only once every slot is occupied.
    semaphore
      .withSlot(keyId, () => {
        return new Promise<void>((resolve) => {
          const releaseSlot = () => {
            res.removeListener('finish', releaseSlot);
            res.removeListener('close', releaseSlot);
            resolve();
          };

          // Guard against handlers that respond synchronously: by the time
          // this microtask runs, 'finish' may already have been emitted (or
          // the socket destroyed), and a late listener would never fire —
          // leaking the slot for the full TTL.
          if (res.writableEnded || res.destroyed) {
            resolve();
            return;
          }

          res.once('finish', releaseSlot);
          res.once('close', releaseSlot);
        });
      })
      .catch((err) => {
        // The response is already in flight, so a slot failure must not crash
        // the process — but it MUST be logged so operators can spot leaks.
        logger.error('[perKeyConcurrency] slot error:', err);
      });

    next();
  };
}

/**
 * Pre-configured per-key concurrency middleware bound to the shared semaphore
 * that the admin stats route reads from.
 */
export function createConfiguredPerKeyConcurrencyMiddleware(): RequestHandler {
  return createPerKeyConcurrencyMiddleware({
    semaphore: sharedKeySemaphore,
    maxConcurrent: config.keyConcurrency.maxPerKey,
  });
}
