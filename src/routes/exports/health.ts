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
import { asyncHandler } from '../../utils/asyncHandler.js';
import { pool } from '../../db.js';
import { config } from '../../config/index.js';
import { validateStorageEndpoint } from '../../lib/storageEndpoint.js';
import { getReportExporterWorkerStatus } from '../../services/reportExporter.js';
import {
  getScheduledExportsWorkerStatus,
  type ExportWorkerStatus,
} from '../../services/scheduledExports.js';

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

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DB_DEGRADED_THRESHOLD_MS = 1_000;
const MAX_DETAIL_LENGTH = 256;

/**
 * Strips credentials, bearer tokens, sensitive query parameters, and configured
 * secrets from a probe detail string so secrets are never leaked in responses
 * or logs.
 */
export function sanitizeDetail(raw: string): string {
  let sanitized = raw.replace(/[\r\n]+/g, ' ').trim();

  // Redact configured signing secret if present verbatim
  const signingSecret = config.exports?.signingSecret;
  if (signingSecret && signingSecret.length > 0) {
    sanitized = sanitized.split(signingSecret).join('[REDACTED]');
  }

  // Redact userinfo in URLs (e.g. postgresql://user:pass@host or https://user:pass@host)
  sanitized = sanitized.replace(/(\/\/)([^/@\s]+):([^/@\s]+)@/g, '$1[REDACTED]@');

  // Redact Bearer / Basic authorization tokens
  sanitized = sanitized.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');

  // Redact sensitive query parameter values
  sanitized = sanitized.replace(
    /([?&](?:signature|token|secret|key|password|passwd|auth|apikey|api_key|access_token|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s]+/gi,
    '$1[REDACTED]',
  );

  if (sanitized.length > MAX_DETAIL_LENGTH) {
    return `${sanitized.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
  }
  return sanitized;
}

/**
 * Wraps a probe thunk with a timeout so that a slow dependency never
 * blocks the health response indefinitely.
 *
 * Also catches synchronous throws from `thunk` and sanitizes error messages.
 *
 * @param name        - Dependency label used in log/error messages.
 * @param thunk       - Async function that resolves to a {@link ProbeResult}.
 * @param timeoutMs   - Maximum milliseconds to wait (default: 5 000).
 * @returns           Resolved {@link ProbeResult}, or a `down` result on timeout.
 */
async function withTimeout(
  name: string,
  thunk: () => Promise<ProbeResult>,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        name,
        status: 'down',
        detail: `Probe timed out after ${timeoutMs} ms`,
      });
    }, timeoutMs);

    Promise.resolve()
      .then(() => thunk())
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        resolve({
          name,
          status: 'down',
          detail: sanitizeDetail(err instanceof Error ? err.message : String(err)),
        });
      });
  });
}

// ---------------------------------------------------------------------------
// Individual probe implementations
//
// Each function is exported so it can be replaced in tests via dependency
// injection through the `ProbeRegistry` type.
// ---------------------------------------------------------------------------

/** Checks connectivity to the primary relational database used by exports. */
export async function probeDatabase(options?: {
  timeoutMs?: number;
  degradedThresholdMs?: number;
}): Promise<ProbeResult> {
  const start = Date.now();
  const timeoutMs = options?.timeoutMs ?? config.database?.timeout ?? DEFAULT_PROBE_TIMEOUT_MS;
  const degradedThresholdMs = options?.degradedThresholdMs ?? DB_DEGRADED_THRESHOLD_MS;

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Database probe timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      Promise.resolve().then(() => pool.query('SELECT 1')),
      timeoutPromise,
    ]);
    const latencyMs = Date.now() - start;
    if (latencyMs > degradedThresholdMs) {
      return {
        name: 'database',
        status: 'degraded',
        latencyMs,
        detail: `Database latency ${latencyMs} ms exceeded threshold (${degradedThresholdMs} ms)`,
      };
    }
    return { name: 'database', status: 'ok', latencyMs };
  } catch (err: unknown) {
    return {
      name: 'database',
      status: 'down',
      detail: sanitizeDetail(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Checks connectivity to the object-storage provider (S3 / blob storage). */
export async function probeStorage(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const start = Date.now();

  if (!config.exports?.enabled) {
    return {
      name: 'storage',
      status: 'ok',
      detail: 'exports disabled',
      latencyMs: Date.now() - start,
    };
  }

  const bucket = config.exports.bucket?.trim();
  const rawEndpoint = config.exports.endpoint?.trim();
  if (!bucket || !rawEndpoint) {
    return {
      name: 'storage',
      status: 'down',
      detail: 'Export storage configuration is incomplete',
    };
  }

  let validatedEndpoint: string;
  try {
    validatedEndpoint = validateStorageEndpoint(rawEndpoint, {
      production: config.nodeEnv === 'production',
      allowedHosts: config.exports.endpointAllowlist,
    });
  } catch (err: unknown) {
    return {
      name: 'storage',
      status: 'down',
      detail: sanitizeDetail(err instanceof Error ? err.message : String(err)),
    };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchFn = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const probeUrl = `${validatedEndpoint}/${encodeURIComponent(bucket)}`;
    const response = await fetchFn(probeUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    if (response.ok) {
      return { name: 'storage', status: 'ok', latencyMs };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        name: 'storage',
        status: 'down',
        detail: `Storage authentication failed (HTTP ${response.status})`,
      };
    }
    if (response.status >= 400 && response.status < 500) {
      return {
        name: 'storage',
        status: 'degraded',
        latencyMs,
        detail: `Storage responded with HTTP ${response.status}`,
      };
    }
    return {
      name: 'storage',
      status: 'down',
      detail: `Storage responded with HTTP ${response.status}`,
    };
  } catch (err: unknown) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return {
        name: 'storage',
        status: 'down',
        detail: `Storage probe timed out after ${timeoutMs} ms`,
      };
    }
    return {
      name: 'storage',
      status: 'down',
      detail: sanitizeDetail(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks health of the exports worker queue (report & scheduled export workers). */
export async function probeQueue(options?: {
  getWorkerStatuses?: () => Array<ExportWorkerStatus | null>;
  maxStaleMs?: number;
}): Promise<ProbeResult> {
  const start = Date.now();

  if (!config.exports?.enabled) {
    return {
      name: 'queue',
      status: 'ok',
      detail: 'exports disabled',
      latencyMs: Date.now() - start,
    };
  }

  const rawStatuses = options?.getWorkerStatuses
    ? options.getWorkerStatuses()
    : [getReportExporterWorkerStatus(), getScheduledExportsWorkerStatus()];
  const workers = rawStatuses.filter((status): status is ExportWorkerStatus => status !== null);

  if (workers.length === 0) {
    return {
      name: 'queue',
      status: 'down',
      detail: 'No export workers registered',
    };
  }

  const downReasons: string[] = [];
  const degradedReasons: string[] = [];

  for (const worker of workers) {
    if (worker.state !== 'running') {
      downReasons.push(`worker "${worker.name}" is stopped`);
      continue;
    }

    const staleThresholdMs = options?.maxStaleMs ?? worker.intervalMs * 2;
    if (worker.lastTickAgeMs !== null && worker.lastTickAgeMs > staleThresholdMs) {
      downReasons.push(
        `worker "${worker.name}" is stale (last tick ${worker.lastTickAgeMs} ms ago)`,
      );
      continue;
    }

    if (worker.lastTickAt === null && worker.startedAt !== null) {
      const startedAgeMs = Math.max(0, Date.now() - worker.startedAt.getTime());
      if (startedAgeMs > staleThresholdMs) {
        downReasons.push(
          `worker "${worker.name}" has not ticked since start (${startedAgeMs} ms ago)`,
        );
        continue;
      }
    }

    if (worker.lastError) {
      degradedReasons.push(
        `worker "${worker.name}" error: ${sanitizeDetail(worker.lastError)}`,
      );
    }
  }

  if (downReasons.length > 0) {
    return {
      name: 'queue',
      status: 'down',
      detail: sanitizeDetail(downReasons.join('; ')),
    };
  }

  if (degradedReasons.length > 0) {
    return {
      name: 'queue',
      status: 'degraded',
      latencyMs: Date.now() - start,
      detail: sanitizeDetail(degradedReasons.join('; ')),
    };
  }

  return { name: 'queue', status: 'ok', latencyMs: Date.now() - start };
}

/** Checks connectivity to the third-party notification / delivery API. */
export async function probeNotificationApi(options?: {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const start = Date.now();
  const rawUrl = options?.url ?? config.exports?.notificationHealthUrl;

  if (!rawUrl || rawUrl.trim() === '') {
    return {
      name: 'notificationApi',
      status: 'ok',
      detail: 'notification health URL not configured',
      latencyMs: Date.now() - start,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        name: 'notificationApi',
        status: 'down',
        detail: 'Invalid notification health URL',
      };
    }
  } catch {
    return {
      name: 'notificationApi',
      status: 'down',
      detail: 'Invalid notification health URL',
    };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchFn = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(parsedUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    if (response.ok) {
      return { name: 'notificationApi', status: 'ok', latencyMs };
    }

    return {
      name: 'notificationApi',
      status: 'down',
      detail: `Notification API responded with HTTP ${response.status}`,
    };
  } catch (err: unknown) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return {
        name: 'notificationApi',
        status: 'down',
        detail: `Notification API probe timed out after ${timeoutMs} ms`,
      };
    }
    return {
      name: 'notificationApi',
      status: 'down',
      detail: sanitizeDetail(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
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
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
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
  }));

  return router;
}