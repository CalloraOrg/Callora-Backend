/**
 * @file health.ts
 * @description Dependency health probe for the /api/exports route group.
 *
 * Exposes `GET /api/exports/health`, which concurrently checks every external
 * dependency relied on by the exports feature (database, object storage, queue,
 * and third-party notification API) and returns a structured JSON payload
 * containing per-dependency status and an aggregated overall health status.
 *
 * Structured log lines are emitted at each stage, all carrying the
 * `correlationId` derived from the incoming `x-correlation-id` header (or a
 * generated UUID fallback) so that requests can be traced end-to-end.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Granular health status of a single dependency. */
export type DependencyStatus = 'ok' | 'degraded' | 'down';

/** Aggregated health status for the whole endpoint. */
export type OverallStatus = 'ok' | 'degraded' | 'down';

/** Result returned by a single dependency probe. */
export interface ProbeResult {
  /** Human-readable name of the dependency. */
  name: string;
  /** Connectivity / health status. */
  status: DependencyStatus;
  /** Optional human-readable detail (e.g. error message on failure). */
  detail?: string;
  /** Round-trip latency in milliseconds (undefined when the probe errors out). */
  latencyMs?: number;
}

/** Shape of the JSON body returned by `GET /api/exports/health`. */
export interface ExportsHealthResponse {
  /** Aggregated status across all dependencies. */
  overall: OverallStatus;
  /** Per-dependency probe results. */
  dependencies: ProbeResult[];
  /** ISO-8601 timestamp of when the probe was executed. */
  checkedAt: string;
  /** Correlation ID echoed back so callers can match logs to responses. */
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

/**
 * Emits a single structured log line to stdout.
 *
 * All log entries carry a `correlationId` field so that the full lifecycle of
 * a request can be reconstructed by filtering on that value.
 *
 * @param level       - Severity level.
 * @param message     - Human-readable message.
 * @param correlationId - Request-scoped correlation identifier.
 * @param extra       - Any additional key/value pairs to merge into the entry.
 */
export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  correlationId: string,
  extra?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    correlationId,
    message,
    ...extra,
  };
  // Always write to stdout so that process-level log aggregators can consume it.
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Dependency probes
// ---------------------------------------------------------------------------

/**
 * Wraps a probe thunk with a timeout so that a slow dependency never
 * blocks the health response indefinitely.
 *
 * @param name        - Dependency label used in log/error messages.
 * @param thunk       - Async function that resolves to a {@link ProbeResult}.
 * @param timeoutMs   - Maximum milliseconds to wait (default: 5 000).
 * @returns           Resolved {@link ProbeResult}, or a `down` result on timeout.
 */
async function withTimeout(
  name: string,
  thunk: () => Promise<ProbeResult>,
  timeoutMs = 5_000,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        name,
        status: 'down',
        detail: `Probe timed out after ${timeoutMs} ms`,
      });
    }, timeoutMs);

    thunk()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        resolve({
          name,
          status: 'down',
          detail: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

// ---------------------------------------------------------------------------
// Individual probe implementations
//
// Each function is exported so it can be replaced in tests via dependency
// injection through the `ProbeRegistry` type. The default implementations are
// no-op stubs that simulate a successful connection; swap them out for real
// client calls once the corresponding infrastructure clients are introduced.
// ---------------------------------------------------------------------------

/** Checks connectivity to the primary relational database used by exports. */
export async function probeDatabase(): Promise<ProbeResult> {
  const start = Date.now();
  // TODO: replace with real DB ping, e.g. `pool.query('SELECT 1')`
  return { name: 'database', status: 'ok', latencyMs: Date.now() - start };
}

/** Checks connectivity to the object-storage provider (S3 / blob storage). */
export async function probeStorage(): Promise<ProbeResult> {
  const start = Date.now();
  // TODO: replace with real S3/blob head-bucket call
  return { name: 'storage', status: 'ok', latencyMs: Date.now() - start };
}

/** Checks connectivity to the export job queue (e.g. SQS, RabbitMQ, Redis). */
export async function probeQueue(): Promise<ProbeResult> {
  const start = Date.now();
  // TODO: replace with real queue ping
  return { name: 'queue', status: 'ok', latencyMs: Date.now() - start };
}

/** Checks connectivity to the third-party notification / delivery API. */
export async function probeNotificationApi(): Promise<ProbeResult> {
  const start = Date.now();
  // TODO: replace with real HTTP health call to third-party API
  return { name: 'notificationApi', status: 'ok', latencyMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Probe registry — injectable for testing
// ---------------------------------------------------------------------------

/**
 * A map of named probe functions.
 * Callers can override individual probes during tests without rewiring the
 * entire router.
 */
export type ProbeRegistry = {
  database: () => Promise<ProbeResult>;
  storage: () => Promise<ProbeResult>;
  queue: () => Promise<ProbeResult>;
  notificationApi: () => Promise<ProbeResult>;
};

/** Default production probe registry. */
export const defaultProbes: ProbeRegistry = {
  database: probeDatabase,
  storage: probeStorage,
  queue: probeQueue,
  notificationApi: probeNotificationApi,
};

// ---------------------------------------------------------------------------
// Overall status derivation
// ---------------------------------------------------------------------------

/**
 * Derives the aggregated {@link OverallStatus} from a list of probe results.
 *
 * - `down`     — at least one dependency is `down`
 * - `degraded` — no `down`, but at least one dependency is `degraded`
 * - `ok`       — all dependencies are `ok`
 *
 * @param results - Array of completed probe results.
 */
export function deriveOverallStatus(results: ProbeResult[]): OverallStatus {
  if (results.some((r) => r.status === 'down')) return 'down';
  if (results.some((r) => r.status === 'degraded')) return 'degraded';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns an Express {@link Router} that handles
 * `GET /api/exports/health`.
 *
 * Accepting an optional `probes` parameter keeps the route logic decoupled
 * from the real infrastructure clients, enabling fast unit tests without
 * network calls.
 *
 * @param probes - Probe registry to use (defaults to {@link defaultProbes}).
 */
export function createExportsHealthRouter(
  probes: ProbeRegistry = defaultProbes,
): Router {
  const router = Router();

  /**
   * GET /api/exports/health
   *
   * Probes all external dependencies of the exports feature and returns their
   * health status.
   *
   * @returns 200 when overall status is `ok` or `degraded`.
   * @returns 503 when overall status is `down`.
   */
  router.get('/', async (req: Request, res: Response) => {
    // ------------------------------------------------------------------
    // 1. Resolve correlation ID
    // ------------------------------------------------------------------
    const rawHeader = req.headers['x-correlation-id'];
    const correlationId =
      typeof rawHeader === 'string' && rawHeader.trim() !== ''
        ? rawHeader.trim()
        : randomUUID();

    log('info', 'exports health probe started', correlationId, {
      method: req.method,
      path: req.originalUrl,
    });

    // ------------------------------------------------------------------
    // 2. Run all probes concurrently, each guarded by a timeout
    // ------------------------------------------------------------------
    const results = await Promise.all([
      withTimeout('database', probes.database),
      withTimeout('storage', probes.storage),
      withTimeout('queue', probes.queue),
      withTimeout('notificationApi', probes.notificationApi),
    ]);

    // ------------------------------------------------------------------
    // 3. Log individual probe outcomes
    // ------------------------------------------------------------------
    for (const result of results) {
      const level = result.status === 'ok' ? 'info' : 'warn';
      log(level, `probe result: ${result.name}`, correlationId, {
        dependency: result.name,
        status: result.status,
        latencyMs: result.latencyMs,
        detail: result.detail,
      });
    }

    // ------------------------------------------------------------------
    // 4. Derive overall status and build response
    // ------------------------------------------------------------------
    const overall = deriveOverallStatus(results);
    const httpStatus = overall === 'down' ? 503 : 200;

    const body: ExportsHealthResponse = {
      overall,
      dependencies: results,
      checkedAt: new Date().toISOString(),
      correlationId,
    };

    log('info', 'exports health probe completed', correlationId, {
      overall,
      httpStatus,
    });

    res.status(httpStatus).json(body);
  });

  return router;
}
