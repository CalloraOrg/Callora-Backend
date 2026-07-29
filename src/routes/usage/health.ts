/**
 * Usage Subsystem Health Probe
 *
 * GET /api/usage/health
 *
 * Returns the live operational status of every external dependency that
 * the `/api/usage` surface area relies on:
 *
 *   - **database**    – PostgreSQL (usage event persistence and aggregation).
 *   - **soroban_rpc** – Stellar Soroban RPC (billing deduction & settlement),
 *                       included only when `SOROBAN_RPC_ENABLED=true`.
 *   - **horizon**     – Stellar Horizon REST API (on-chain settlement sync),
 *                       included only when `HORIZON_ENABLED=true`.
 *
 * Each dependency is probed independently in parallel so a slow external
 * service cannot stall the entire response.  Error messages are sanitised
 * before being returned to prevent leaking connection strings, hostnames,
 * credentials, or stack traces.
 *
 * ### HTTP status codes
 * | Code | Meaning |
 * |------|---------|
 * | 200  | All probed dependencies are `ok` or at worst `degraded`. |
 * | 503  | At least one critical dependency (`database`) is `down`.  |
 *
 * ### Authentication
 * The endpoint is public (no auth required) so that load-balancer health
 * checks and external monitoring systems can poll it without credentials.
 *
 * @module routes/usage/health
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  checkDatabase,
  checkSorobanRpc,
  checkHorizon,
  determineOverallStatus,
  type ComponentCheck,
  type HealthCheckConfig,
} from '../../services/healthCheck.js';
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
export interface UsageDependencyEntry {
  /** Rolled-up status for this dependency. */
  status: ComponentStatus;
  /** Round-trip time in milliseconds (omitted when not measurable). */
  responseTime?: number;
  /**
   * Sanitised error category, present only when the dependency is not `ok`:
   * - `"timeout"`             – the probe timed out.
   * - `"unavailable"`         – connection failed or unexpected error.
   * - `"unexpected_response"` – the probe completed but the result was wrong.
   * - `"HTTP <code>"`         – the remote returned a non-2xx HTTP status.
   */
  error?: string;
}

/** Full response body for `GET /api/usage/health`. */
export interface UsageHealthResponse {
  /** Rolled-up status across all probed dependencies. */
  status: ComponentStatus;
  /** ISO-8601 timestamp of when this probe was executed. */
  timestamp: string;
  /**
   * Per-dependency status map.  Keys are stable, machine-readable names:
   * `database`, `soroban_rpc`, `horizon`.
   */
  dependencies: Record<string, UsageDependencyEntry>;
}

// ---------------------------------------------------------------------------
// Dependency injection contract
// ---------------------------------------------------------------------------

/**
 * External dependencies injected into the router factory.
 *
 * Mirrors the pattern used by `createDependenciesRouter` in
 * `src/routes/health/dependencies.ts`.  When `config` is omitted the
 * router returns an empty, healthy dependencies object — useful for tests
 * that do not require live probes.
 */
export interface UsageHealthRouterDeps {
  /** Optional health-check configuration (DB pool, RPC URLs, etc.). */
  config?: HealthCheckConfig;
}

// ---------------------------------------------------------------------------
// Error sanitisation
// ---------------------------------------------------------------------------

/**
 * Converts a raw {@link ComponentCheck} into a safe {@link UsageDependencyEntry}.
 *
 * Only error *categories* are exposed externally; raw OS / driver error
 * messages that could leak topology information are replaced.
 *
 * @param check - Raw probe result from `services/healthCheck`.
 * @returns Safe representation for inclusion in HTTP responses.
 */
export function sanitizeUsageCheck(check: ComponentCheck): UsageDependencyEntry {
  const entry: UsageDependencyEntry = { status: check.status };

  if (check.responseTime !== undefined) {
    entry.responseTime = check.responseTime;
  }

  if (check.error) {
    if (check.error === 'Timeout' || check.error === 'Database check timeout') {
      entry.error = 'timeout';
    } else if (check.error.startsWith('HTTP ')) {
      // Preserve HTTP status codes — they are not sensitive.
      entry.error = check.error;
    } else if (check.error === 'Unexpected query result') {
      entry.error = 'unexpected_response';
    } else {
      // Replace all other messages (connection strings, hostnames, …) with a
      // generic category so internal topology is never disclosed.
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
 * point (i.e. `GET /api/usage/health` when mounted via `createApiRouter`).
 *
 * Dependencies are probed in parallel using `Promise.all`; each probe has
 * its own bounded timeout so the total wall-clock time is bounded by the
 * slowest individual timeout, not their sum.
 *
 * @param deps - Optional dependency injection. Omit for test/no-op mode.
 *
 * @example Mount in `createApiRouter`
 * ```ts
 * import { createUsageHealthRouter } from './usage/health.js';
 *
 * router.use(
 *   '/usage/health',
 *   createUsageHealthRouter({ config: healthCheckConfig }),
 * );
 * ```
 */
export function createUsageHealthRouter(deps: UsageHealthRouterDeps = {}): Router {
  const router = Router();
  const { config } = deps;

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    // Prefer the request-id attached by the requestId middleware; fall back
    // to the raw header value or a safe default for traceability.
    const requestId =
      (req as Request & { id?: string }).id ??
      (req.headers['x-request-id'] as string | undefined) ??
      'unknown';

    logger.info('[usage/health] probe requested', { requestId });

    // -----------------------------------------------------------------------
    // Fast path: no config → nothing to probe, return healthy empty response.
    // This covers the case where the application is started without a DB pool
    // (e.g. unit tests or local dev without environment variables).
    // -----------------------------------------------------------------------
    if (!config?.database) {
      const response: UsageHealthResponse = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        dependencies: {},
      };

      logger.info('[usage/health] probe completed (no config)', {
        requestId,
        status: 'ok',
      });

      res.status(200).json(response);
      return;
    }

    try {
      // -----------------------------------------------------------------------
      // Probe all configured dependencies in parallel.
      // -----------------------------------------------------------------------
      const [dbCheck, sorobanCheck, horizonCheck] = await Promise.all([
        checkDatabase(config.database.pool, config.database.timeout),
        config.sorobanRpc
          ? checkSorobanRpc(config.sorobanRpc.url, config.sorobanRpc.timeout)
          : Promise.resolve(undefined),
        config.horizon
          ? checkHorizon(config.horizon.url, config.horizon.timeout)
          : Promise.resolve(undefined),
      ]);

      // -----------------------------------------------------------------------
      // Build the sanitised dependency map.
      // -----------------------------------------------------------------------
      const dependencies: Record<string, UsageDependencyEntry> = {
        database: sanitizeUsageCheck(dbCheck),
      };

      if (sorobanCheck !== undefined) {
        dependencies.soroban_rpc = sanitizeUsageCheck(sorobanCheck);
      }

      if (horizonCheck !== undefined) {
        dependencies.horizon = sanitizeUsageCheck(horizonCheck);
      }

      // -----------------------------------------------------------------------
      // Roll up the overall status.
      // -----------------------------------------------------------------------
      const overallStatus = determineOverallStatus({
        api: 'ok',
        database: dbCheck.status,
        soroban_rpc: sorobanCheck?.status,
        horizon: horizonCheck?.status,
      });

      logger.info('[usage/health] probe completed', {
        requestId,
        overallStatus,
        statuses: Object.fromEntries(
          Object.entries(dependencies).map(([k, v]) => [k, v.status]),
        ),
      });

      const response: UsageHealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        dependencies,
      };

      // 503 signals "at least one critical dependency is down" to
      // load-balancers and uptime monitors that only inspect status codes.
      const statusCode = overallStatus === 'down' ? 503 : 200;
      res.status(statusCode).json(response);
    } catch (error) {
      // Surface internal errors via the shared errorHandler middleware so
      // the response shape remains consistent with the rest of the API.
      logger.error('[usage/health] probe failed unexpectedly', {
        requestId,
        error,
      });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createUsageHealthRouter;
