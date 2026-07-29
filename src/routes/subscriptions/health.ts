/**
 * Subscriptions Health Dependency Probe
 *
 * GET /api/subscriptions/health
 *
 * Returns the operational status of every external dependency that
 * the `/api/subscriptions` surface area relies on:
 *
 *   - **database** – SQLite / PostgreSQL (subscription persistence and queries).
 *
 * The database is probed independently so a slow connection cannot stall
 * the entire response. Error messages are sanitised before being returned
 * to prevent leaking connection strings, hostnames, credentials, or stack
 * traces.
 *
 * ### HTTP status codes
 * | Code | Meaning |
 * |------|---------|
 * | 200  | All probed dependencies are `ok` or at worst `degraded`. |
 * | 503  | At least one critical dependency (`database`) is `down`. |
 *
 * ### Authentication
 * The endpoint is public (no auth required) so that load-balancer health
 * checks and external monitoring systems can poll it without credentials.
 *
 * @module routes/subscriptions/health
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { checkDatabase, determineOverallStatus } from '../../services/healthCheck.js';
import type { ComponentCheck, HealthCheckConfig } from '../../services/healthCheck.js';
import { InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status vocabulary aligned with the rest of the Callora health surface. */
export type ComponentStatus = 'ok' | 'degraded' | 'down';

/**
 * Sanitised status entry for a single external dependency.
 *
 * Raw error messages from network I/O (which can contain connection
 * strings, hostnames, or credentials) are replaced with safe category
 * strings before being serialised into the response.
 */
export interface SubscriptionDependencyEntry {
  /** Rolled-up status for this dependency. */
  status: ComponentStatus;
  /** Round-trip time in milliseconds (omitted when not measurable). */
  responseTime?: number;
  /**
   * Sanitised error category, present only when the dependency is not `ok`:
   * - `"timeout"`             – the probe timed out.
   * - `"unavailable"`         – connection failed or unexpected error.
   * - `"unexpected_response"` – the probe completed but the result was wrong.
   */
  error?: string;
}

/** Full response body for `GET /api/subscriptions/health`. */
export interface SubscriptionHealthResponse {
  /** Rolled-up status across all probed dependencies. */
  status: ComponentStatus;
  /** ISO-8601 timestamp of when this probe was executed. */
  timestamp: string;
  /**
   * Per-dependency status map. Keys are stable, machine-readable names:
   * `database`.
   */
  dependencies: Record<string, SubscriptionDependencyEntry>;
}

// ---------------------------------------------------------------------------
// Dependency injection contract
// ---------------------------------------------------------------------------

/**
 * External dependencies injected into the router factory.
 *
 * Mirrors the pattern used by other health route modules. When `config` is
 * omitted the router returns an empty, healthy dependencies object — useful
 * for tests that do not require live probes.
 */
export interface SubscriptionHealthRouterDeps {
  /** Optional health-check configuration (DB pool, timeouts, etc.). */
  config?: HealthCheckConfig;
}

// ---------------------------------------------------------------------------
// Error sanitisation
// ---------------------------------------------------------------------------

/**
 * Converts a raw {@link ComponentCheck} into a safe {@link SubscriptionDependencyEntry}.
 *
 * Only error *categories* are exposed externally; raw OS / driver error
 * messages that could leak topology information are replaced.
 *
 * @param check - Raw probe result from `services/healthCheck`.
 * @returns Safe representation for inclusion in HTTP responses.
 */
export function sanitizeSubscriptionCheck(check: ComponentCheck): SubscriptionDependencyEntry {
  const entry: SubscriptionDependencyEntry = { status: check.status };

  if (check.responseTime !== undefined) {
    entry.responseTime = check.responseTime;
  }

  if (check.error) {
    if (check.error === 'Timeout' || check.error === 'Database check timeout') {
      entry.error = 'timeout';
    } else if (check.error.startsWith('HTTP ')) {
      entry.error = check.error;
    } else if (check.error === 'Unexpected query result') {
      entry.error = 'unexpected_response';
    } else {
      entry.error = 'unavailable';
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates the Express router that handles `GET /` relative to its mount
 * point (i.e. `GET /api/subscriptions/health` when mounted via `createApiRouter`).
 *
 * The database dependency is probed with a bounded timeout so the total
 * wall-clock time is bounded by the configured timeout.
 *
 * @param deps - Optional dependency injection. Omit for test/no-op mode.
 *
 * @example Mount in `createApiRouter`
 * ```ts
 * import { createSubscriptionHealthRouter } from './subscriptions/health.js';
 *
 * router.use(
 *   '/subscriptions/health',
 *   createSubscriptionHealthRouter({ config: healthCheckConfig }),
 * );
 * ```
 */
export function createSubscriptionHealthRouter(
  deps: SubscriptionHealthRouterDeps = {},
): Router {
  const router = Router();
  const { config } = deps;

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const requestId =
      (req as Request & { id?: string }).id ??
      (req.headers['x-request-id'] as string | undefined) ??
      'unknown';

    logger.info('[subscriptions/health] probe requested', { requestId });

    if (!config?.database) {
      const response: SubscriptionHealthResponse = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        dependencies: {},
      };

      logger.info('[subscriptions/health] probe completed (no config)', {
        requestId,
        status: 'ok',
      });

      res.status(200).json(response);
      return;
    }

    try {
      const dbCheck = await checkDatabase(config.database.pool, config.database.timeout);

      const dependencies: Record<string, SubscriptionDependencyEntry> = {
        database: sanitizeSubscriptionCheck(dbCheck),
      };

      const overallStatus = determineOverallStatus({
        api: 'ok',
        database: dbCheck.status,
      });

      logger.info('[subscriptions/health] probe completed', {
        requestId,
        overallStatus,
        statuses: Object.fromEntries(
          Object.entries(dependencies).map(([k, v]) => [k, v.status]),
        ),
      });

      const response: SubscriptionHealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        dependencies,
      };

      const statusCode = overallStatus === 'down' ? 503 : 200;
      res.status(statusCode).json(response);
    } catch (error) {
      logger.error('[subscriptions/health] probe failed unexpectedly', {
        requestId,
        error,
      });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createSubscriptionHealthRouter;
