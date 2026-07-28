/**
 * Webhook Subsystem Health Probe
 *
 * Returns an at-a-glance snapshot of the webhook subsystem's operational
 * health — registered subscriber count, dead-letter queue (DLQ) depth, and
 * the most recent delivery failures.  No external network calls are made;
 * all data is sourced from the in-memory {@link WebhookStore}.
 *
 * Intended audience: operations dashboards, alerting pipelines, and
 * automated runbooks.  The endpoint is deliberately read-only and carries
 * no authentication requirement so it can be polled by load-balancer health
 * checks without extra credential management.
 *
 * Security considerations:
 *   - Webhook secrets are never exposed.  The {@link FailedDeliveryEntry}
 *     entries stored in {@link WebhookStore.getRecentFailures} only contain
 *     non-sensitive operational metadata (deliveryId, event type, target URL,
 *     timestamps, and a sanitised error message).
 *   - Target URLs are included in recent-failure entries because they are
 *     already known to the subscribing developer and are needed for
 *     diagnosis.  They are never returned in un-sanitised form beyond what
 *     the developer originally registered.
 */

import { Router } from 'express';
import { WebhookStore } from '../../webhooks/webhook.store.js';
import { InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** Status vocabulary shared with the rest of the health surface area. */
export type ComponentStatus = 'ok' | 'degraded' | 'down';

/**
 * Metadata about a single past delivery failure retained in the
 * failed-delivery log.  This is a safe projection of
 * {@link import('../../webhooks/webhook.store.js').FailedDeliveryEntry} —
 * secrets are never included.
 */
export interface WebhookFailureSummary {
  /** Unique ID assigned to this delivery attempt. */
  deliveryId: string;
  /** Developer whose subscription triggered the delivery. */
  developerId: string;
  /** Webhook event type that was being delivered. */
  event: string;
  /** Target URL that was called (registered by the developer). */
  url: string;
  /** ISO-8601 timestamp of the final failure. */
  failedAt: string;
  /** Human-readable, non-sensitive last error message. */
  lastError: string;
  /** Total number of delivery attempts made before giving up. */
  attempts: number;
}

/**
 * Full response body for `GET /api/webhooks/health`.
 *
 * `status` rolls up the subsystem health:
 *   - `"ok"`       — DLQ is empty and no recent failures.
 *   - `"degraded"` — recent delivery failures exist but the DLQ is not
 *                    overloaded (DLQ depth below {@link DLQ_WARN_THRESHOLD}).
 *   - `"down"`     — DLQ depth has reached or exceeded
 *                    {@link DLQ_WARN_THRESHOLD}, indicating a systemic
 *                    delivery problem.
 */
export interface WebhookHealthResponse {
  /** Rolled-up subsystem status. */
  status: ComponentStatus;
  /** ISO-8601 timestamp of when this response was generated. */
  timestamp: string;
  /** Webhook subsystem metrics. */
  webhooks: {
    /** Total number of registered webhook subscriptions. */
    registeredCount: number;
    /** Current number of entries waiting in the dead-letter queue. */
    dlqDepth: number;
    /**
     * The `limit` most-recent failed-delivery entries, newest first.
     * Capped at {@link RECENT_FAILURES_LIMIT}.
     */
    recentFailures: WebhookFailureSummary[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * DLQ depth at or above which the subsystem is considered `"down"`.
 * Below this threshold with at least one recent failure → `"degraded"`.
 */
export const DLQ_WARN_THRESHOLD = 10;

/** Maximum number of recent-failure entries returned per response. */
export const RECENT_FAILURES_LIMIT = 20;

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Derives a rolled-up {@link ComponentStatus} from live webhook metrics.
 *
 * Rules (evaluated in priority order):
 * 1. `dlqDepth >= DLQ_WARN_THRESHOLD` → `"down"`
 * 2. `recentFailureCount > 0`          → `"degraded"`
 * 3. Otherwise                          → `"ok"`
 *
 * @param dlqDepth          - Current DLQ entry count.
 * @param recentFailureCount - Number of recent failures surfaced by the store.
 */
export function deriveWebhookStatus(
  dlqDepth: number,
  recentFailureCount: number,
): ComponentStatus {
  if (dlqDepth >= DLQ_WARN_THRESHOLD) {
    return 'down';
  }
  if (recentFailureCount > 0) {
    return 'degraded';
  }
  return 'ok';
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates the Express router that handles `GET /health` (relative to its
 * mount point, i.e. `GET /api/webhooks/health` when mounted on the webhook
 * router).
 *
 * @example
 * ```ts
 * // In webhook.routes.ts
 * import { createWebhookHealthRouter } from '../routes/webhooks/health.js';
 * router.use('/health', createWebhookHealthRouter());
 * ```
 */
export function createWebhookHealthRouter(): Router {
  const router = Router();

  /**
   * GET /api/webhooks/health
   *
   * Returns a snapshot of the webhook subsystem health, including registered
   * subscriber count, DLQ depth, and recent delivery failures.
   *
   * ### Response codes
   * | Status | Meaning |
   * |--------|---------|
   * | `200`  | Subsystem is `ok` or `degraded`. |
   * | `503`  | Subsystem is `down` (DLQ at or above threshold). |
   * | `500`  | Unexpected internal error; details are not leaked. |
   *
   * ### Example — all healthy
   * ```json
   * {
   *   "status": "ok",
   *   "timestamp": "2026-07-26T12:00:00.000Z",
   *   "webhooks": {
   *     "registeredCount": 3,
   *     "dlqDepth": 0,
   *     "recentFailures": []
   *   }
   * }
   * ```
   *
   * ### Example — degraded (recent failures)
   * ```json
   * {
   *   "status": "degraded",
   *   "timestamp": "2026-07-26T12:00:00.000Z",
   *   "webhooks": {
   *     "registeredCount": 3,
   *     "dlqDepth": 2,
   *     "recentFailures": [
   *       {
   *         "deliveryId": "abc123",
   *         "developerId": "dev_001",
   *         "event": "settlement_completed",
   *         "url": "https://example.com/hook",
   *         "failedAt": "2026-07-26T11:59:00.000Z",
   *         "lastError": "HTTP 503 Service Unavailable",
   *         "attempts": 5
   *       }
   *     ]
   *   }
   * }
   * ```
   */
  router.get('/', (req, res, next) => {
    // Correlation ID for log tracing — mirrors the pattern used in
    // src/routes/health/dependencies.ts and src/routes/health/db.ts.
    const requestId = req.id || 'unknown';

    logger.info('[webhooks/health] probe requested', { requestId });

    try {
      const registeredCount = WebhookStore.list().length;
      const dlqDepth = WebhookStore.dlqDepth();
      const recentFailures: WebhookFailureSummary[] = WebhookStore.getRecentFailures(
        RECENT_FAILURES_LIMIT,
      );

      const status = deriveWebhookStatus(dlqDepth, recentFailures.length);

      logger.info('[webhooks/health] probe completed', {
        requestId,
        status,
        registeredCount,
        dlqDepth,
        recentFailuresCount: recentFailures.length,
      });

      const body: WebhookHealthResponse = {
        status,
        timestamp: new Date().toISOString(),
        webhooks: {
          registeredCount,
          dlqDepth,
          recentFailures,
        },
      };

      // 503 when the subsystem is considered "down" so that automated health
      // checks (load-balancers, uptime monitors) can act without parsing the
      // body.  "degraded" is still a 200 — it signals an issue but the
      // subsystem is functional.
      const statusCode = status === 'down' ? 503 : 200;
      res.status(statusCode).json(body);
    } catch (error) {
      logger.error('[webhooks/health] probe failed unexpectedly', {
        requestId,
        error,
      });
      next(new InternalServerError());
    }
  });

  return router;
}
