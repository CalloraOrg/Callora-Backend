/**
 * @module routes/logs
 *
 * GET  /api/logs  — Retrieve structured log entries for the authenticated user.
 * POST /api/logs  — Submit a new structured log entry.
 *
 * ## Rate Limiting
 *
 * Every route in this module is guarded by a **per-user token-bucket** rate
 * limiter.  The bucket parameters are driven by environment variables:
 *
 *   LOGS_RATE_LIMIT_CAPACITY   – burst ceiling (tokens).  Default: 60.
 *   LOGS_RATE_LIMIT_REFILL_RATE – tokens refilled per second.  Default: 1.
 *
 * When the bucket is empty the endpoint responds immediately with:
 *
 *   HTTP 429 Too Many Requests
 *   Retry-After: <seconds until next token is available>
 *
 * The response body follows the canonical error envelope:
 *   { code, message, requestId, retryAfterMs }
 *
 * Key resolution (in priority order):
 *   1. Authenticated user ID extracted from the JWT `Authorization: Bearer`
 *      header (claim `userId` or `sub`).
 *   2. `x-user-id` request header (trusted internal/test header).
 *   3. Client IP address (unauthenticated fallback).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  createTokenBucketRateLimitMiddleware,
  TokenBucketRateLimiter,
  type TokenBucketOptions,
} from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { successEnvelope, getRequestId } from "../lib/envelope.js";
import { logger } from "../logger.js";
import { config } from "../config/index.js";

// ─── In-memory store (replaced by real persistence in production) ─────────────

export interface LogEntry {
  id: string;
  userId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

// Module-level in-memory log store.  Exported so tests can reset it.
export const logStore: LogEntry[] = [];
let _nextId = 1;

/** Reset the in-memory store (for testing purposes only). */
export function resetLogStore(): void {
  logStore.length = 0;
  _nextId = 1;
}

// ─── Validation schemas ───────────────────────────────────────────────────────

export const createLogSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  message: z.string().trim().min(1).max(4096),
  meta: z.record(z.unknown()).optional().default({}),
});

export type CreateLogInput = z.infer<typeof createLogSchema>;

// ─── Async-handler helper ─────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ─── Router factory ───────────────────────────────────────────────────────────

export interface LogsRouterDeps {
  /**
   * Token-bucket options for the rate limiter.  Defaults to values read from
   * `config.logsRateLimit` (which are derived from env vars).
   */
  rateLimitOptions?: TokenBucketOptions;

  /**
   * Pre-built rate-limiter instance.  When provided the `rateLimitOptions`
   * parameter is ignored.  Primarily for unit-testing with a pre-seeded bucket.
   */
  rateLimiter?: TokenBucketRateLimiter;
}

export function createLogsRouter(deps: LogsRouterDeps = {}): Router {
  const router = Router();

  // Build the rate-limit middleware for this router instance.
  // Injecting a custom limiter (or options) from tests keeps the real
  // config untouched while still exercising the live middleware path.
  const rateLimitOptions: TokenBucketOptions =
    deps.rateLimitOptions ?? config.logsRateLimit;

  const rateLimitMiddleware = createTokenBucketRateLimitMiddleware(
    rateLimitOptions,
    deps.rateLimiter,
  );

  /**
   * GET /api/logs
   *
   * Returns log entries for the authenticated user, ordered newest-first.
   * Responds with the canonical success envelope.
   *
   * Requires authentication (JWT bearer token or x-user-id header in
   * non-production environments).
   *
   * Rate-limited per user (token-bucket).
   */
  router.get(
    "/",
    rateLimitMiddleware,
    requireAuth,
    asyncHandler(async (req, res) => {
      const requestId = getRequestId(req);
      const userId = res.locals.authenticatedUser!.id;

      const entries = logStore
        .filter((e) => e.userId === userId)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

      logger.info(
        { requestId, userId, count: entries.length },
        "[logs] GET /api/logs",
      );

      res.json(
        successEnvelope(
          { logs: entries },
          requestId,
          { total: entries.length },
        ),
      );
    }),
  );

  /**
   * POST /api/logs
   *
   * Create a new log entry for the authenticated user.
   * Returns the created entry wrapped in a success envelope (HTTP 201).
   *
   * Body:
   *   {
   *     "level":   "debug" | "info" | "warn" | "error"  (default: "info")
   *     "message": string (1-4096 chars)
   *     "meta":    object (optional, default: {})
   *   }
   *
   * Rate-limited per user (token-bucket).
   */
  router.post(
    "/",
    rateLimitMiddleware,
    requireAuth,
    validate({ body: createLogSchema }),
    asyncHandler(async (req, res) => {
      const requestId = getRequestId(req);
      const userId = res.locals.authenticatedUser!.id;
      const input = createLogSchema.parse(req.body) as CreateLogInput;

      const entry: LogEntry = {
        id: String(_nextId++),
        userId,
        level: input.level,
        message: input.message,
        meta: input.meta,
        createdAt: new Date().toISOString(),
      };

      logStore.push(entry);

      logger.info(
        { requestId, userId, logId: entry.id, level: entry.level },
        "[logs] POST /api/logs — entry created",
      );

      res.status(201).json(successEnvelope(entry, requestId));
    }),
  );

  return router;
}

export default createLogsRouter;
