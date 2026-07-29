import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DeveloperSemaphore, sharedDeveloperSemaphore } from '../utils/developerSemaphore.js';
import { resolveRequestUserId } from './requireAuth.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

export interface PerDevConcurrencyOptions {
  /** Maximum concurrent requests per developer (default: 1). */
  maxConcurrent?: number;
  /** TTL in ms before idle developer state is evicted (default: 300_000). */
  ttlMs?: number;
  /**
   * DeveloperSemaphore instance to use.  When omitted and no other options
   * are customised, defaults to {@link sharedDeveloperSemaphore} so that the
   * admin concurrency-stats route sees real in-flight counts.  Pass an
   * isolated instance in unit tests to avoid cross-test state pollution.
   */
  semaphore?: DeveloperSemaphore;
}

/**
 * Express middleware that enforces a per-developer concurrency limit.
 *
 * When a developer reaches the configured `maxConcurrent` limit, additional
 * requests are immediately rejected with HTTP 429 rather than being queued.
 * This provides fast-fail semantics at the HTTP edge so callers receive a
 * clear signal to back off, while the internal {@link DeveloperSemaphore}
 * provides FIFO fairness within the active slot pool.
 *
 * Developer identity is resolved from the authenticated request using the
 * same mechanism as the REST rate-limiter ({@link resolveRequestUserId}).
 * Unauthenticated requests pass through unchecked.
 *
 * @example
 * // Apply to billing routes with the configured limit:
 * const concurrencyLimit = createPerDevConcurrencyMiddleware({
 *   maxConcurrent: config.billingConcurrency.maxPerDeveloper,
 * });
 * router.use('/billing', concurrencyLimit, billingRouter);
 */
export function createPerDevConcurrencyMiddleware(
  options: PerDevConcurrencyOptions = {},
): RequestHandler {
  const maxConcurrent = options.maxConcurrent ?? config.billingConcurrency.maxPerDeveloper;
  const ttlMs = options.ttlMs ?? config.billingConcurrency.semaphoreTtlMs;

  // Prefer an explicitly supplied semaphore (useful in tests).  Otherwise use
  // the shared singleton when the caller has not customised maxConcurrent/ttlMs
  // so that the admin metrics route observes real in-flight counts.  When the
  // caller HAS customised the limits (e.g. per-route overrides) create a
  // dedicated instance to keep the slot counts independent.
  const semaphore: DeveloperSemaphore =
    options.semaphore ??
    (options.maxConcurrent === undefined && options.ttlMs === undefined
      ? sharedDeveloperSemaphore
      : new DeveloperSemaphore(maxConcurrent, ttlMs));

  return (req: Request, res: Response, next: NextFunction): void => {
    const { userId } = resolveRequestUserId(req);
    if (!userId) {
      // No developer identity — pass through (other middleware will 401)
      next();
      return;
    }

    const active = semaphore.getCurrentActiveSlotCounts()[userId] ?? 0;

    if (active >= maxConcurrent) {
      const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';
      res.status(429).json({
        code: 'TOO_MANY_REQUESTS',
        message: 'Concurrency limit reached. Please retry your request.',
        requestId,
      });
      return;
    }

    // Acquire a slot — this is non-blocking when capacity is available
    // because withSlot uses FIFO queuing only when all slots are occupied.
    semaphore
      .withSlot(userId, () => {
        return new Promise<void>((resolve) => {
          const releaseSlot = () => {
            res.removeListener('finish', releaseSlot);
            res.removeListener('close', releaseSlot);
            resolve();
          };

          // Guard against synchronous response handlers where `res.end()` has
          // already been called by the time this microtask runs and the
          // 'finish' event has already been emitted. Also handles the case
          // where the connection was already destroyed.
          if (res.writableEnded || res.destroyed) {
            resolve();
            return;
          }

          res.once('finish', releaseSlot);
          res.once('close', releaseSlot);
        });
      })
      .catch((err) => {
        // Slot-acquisition failures should not crash the process (the response
        // is already in flight), but they MUST be logged for operators to
        // detect semaphore leaks.
        logger.error('[perDevConcurrency] slot error:', err);
      });

    next();
  };
}

/**
 * Pre-configured per-developer concurrency middleware using the application
 * configuration defaults.
 */
export function createConfiguredPerDevConcurrencyMiddleware(): RequestHandler {
  return createPerDevConcurrencyMiddleware({
    maxConcurrent: config.billingConcurrency.maxPerDeveloper,
    ttlMs: config.billingConcurrency.semaphoreTtlMs,
  });
}
