/**
 * SLO burn-rate alert worker
 *
 * Polls on a fixed interval, evaluates each configured (method, route) pair
 * for `availability` and `latency` burns, and posts deduplicated webhook
 * alerts when a threshold is breached.
 *
 * Lifecycle
 * ---------
 *  - start()           kicks off the first tick and a recurring timer
 *  - stop()            clears the timer; ticks already in flight continue
 *  - beginShutdown()   prevents future ticks and clears the timer
 *  - awaitIdle()       resolves once the current tick completes
 *
 * The mirror of the same factory pattern used by
 * `src/workers/slowQueryAlerter.ts` and `src/workers/anomalyDetector.ts`,
 * ensuring consistent shutdown semantics across background subsystems.
 */

import { logger } from '../logger.js';
import {
  recordSloAlerterRun,
  recordSloAlert,
  setSloAlertActiveBurns,
} from '../metrics.js';
import {
  evaluateBurns,
  sloConfigKey,
  type SloBurnResult,
  type SloRouteConfig,
} from '../services/sloService.js';
import {
  getAllSloWindows,
  getSloConfigs,
} from './sloAlertRecorder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dedup store (in-memory)
// ─────────────────────────────────────────────────────────────────────────────

interface SloAlertDedupStore {
  has(key: string): boolean;
  set(key: string): void;
  cleanup(): void;
}

function createSloAlertDedupStore(windowMs: number): SloAlertDedupStore {
  const store = new Map<string, number>();

  return {
    has(key: string): boolean {
      const expiry = store.get(key);
      if (expiry === undefined) return false;
      if (Date.now() > expiry) {
        store.delete(key);
        return false;
      }
      return true;
    },

    set(key: string): void {
      store.set(key, Date.now() + windowMs);
    },

    cleanup(): void {
      const now = Date.now();
      for (const [key, expiry] of store) {
        if (now > expiry) store.delete(key);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_NAMES: Record<SloBurnResult['kind'], string> = {
  availability: 'errorRate',
  latency: 'p95LatencyMs',
};

function buildAlertPayload(
  config: SloRouteConfig,
  burn: SloBurnResult,
  observationWindowMs: number,
): Record<string, unknown> {
  const observedRounded = Math.round(burn.observed * 1_000_000) / 1_000_000;
  const thresholdRounded = Math.round(burn.threshold * 1_000_000) / 1_000_000;

  return {
    event: 'slo_burn_alert',
    timestamp: new Date().toISOString(),
    data: {
      method: config.method.toUpperCase(),
      route: config.route,
      kind: burn.kind,
      observed: observedRounded,
      threshold: thresholdRounded,
      measuredKey: FIELD_NAMES[burn.kind],
      windowMs: observationWindowMs,
      totalRequests: burn.totalRequests,
      observedAt: new Date().toISOString(),
    },
  };
}

async function postSloAlert(
  webhookUrl: string,
  payload: Record<string, unknown>,
  log: Pick<typeof console, 'error' | 'info' | 'warn'>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Callora-SloAlertJob/1.0',
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      body,
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.error(
        '[sloAlertJob] Webhook returned %d %s',
        response.status,
        response.statusText,
      );
      return;
    }

    log.info(
      '[sloAlertJob] Webhook delivered (status %d)',
      response.status,
    );
  } catch (err) {
    log.error(
      '[sloAlertJob] Webhook post failed: %s',
      (err as Error).message,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job factory
// ─────────────────────────────────────────────────────────────────────────────

export interface SloAlertJobOptions {
  webhookUrl: string;
  pollIntervalMs: number;
  dedupWindowMs: number;
  observationWindowMs: number;
  logger?: Pick<typeof console, 'error' | 'info' | 'warn'>;
}

export interface SloAlertJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createSloAlertJob(options: SloAlertJobOptions): SloAlertJob {
  const log = options.logger ?? logger;

  if (typeof options.webhookUrl !== 'string' || options.webhookUrl.length === 0) {
    throw new Error('webhookUrl is required');
  }
  if (
    !Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0
  ) {
    throw new Error('pollIntervalMs must be a positive integer');
  }
  if (
    !Number.isInteger(options.dedupWindowMs) || options.dedupWindowMs <= 0
  ) {
    throw new Error('dedupWindowMs must be a positive integer');
  }
  if (
    !Number.isFinite(options.observationWindowMs) ||
    options.observationWindowMs <= 0
  ) {
    throw new Error('observationWindowMs must be a positive number');
  }

  const { observationWindowMs } = options;
  const dedup = createSloAlertDedupStore(options.dedupWindowMs);

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) return;

    running = (async () => {
      try {
        recordSloAlerterRun();
        const now = Date.now();
        const configsByKey = getSloConfigs();
        const windowsByKey = getAllSloWindows();

        let activeBurns = 0;
        const routesScanned: string[] = [];

        for (const [key, config] of configsByKey.entries()) {
          const window = windowsByKey.get(key);
          if (!window) continue;

          const metrics = window.getMetrics(now);
          if (metrics.totalRequests === 0) continue;

          routesScanned.push(key);
          const burns = evaluateBurns(config, metrics);
          if (burns.length === 0) continue;

          for (const burn of burns) {
            activeBurns += 1;

            const dedupKey = `${key}:${burn.kind}`;
            if (dedup.has(dedupKey)) continue;

            dedup.set(dedupKey);
            recordSloAlert(key, burn.kind);
            const payload = buildAlertPayload(config, burn, observationWindowMs);
            await postSloAlert(options.webhookUrl, payload, log);
            log.info(
              '[sloAlertJob] %s burn detected on %s: observed=%s threshold=%s requests=%d',
              burn.kind,
              key,
              burn.observed,
              burn.threshold,
              burn.totalRequests,
            );
          }
        }

        dedup.cleanup();
        setSloAlertActiveBurns(activeBurns);
        if (routesScanned.length > 0) {
          log.info(
            '[sloAlertJob] Polled %d route(s); %d active burn(s) on this tick.',
            routesScanned.length,
            activeBurns,
          );
        }
      } catch (error) {
        log.error('[sloAlertJob] Job failed:', error);
      } finally {
        running = null;
      }
    })();

    await running;
  };

  return {
    start(): void {
      if (timer || !accepting) return;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, options.pollIntervalMs);
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    beginShutdown(): void {
      accepting = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async awaitIdle(): Promise<void> {
      await (running ?? Promise.resolve());
    },
  };
}

/**
 * Test-only helper: assess whether the alerter would emit for a (method,
 * route, kind) tuple right now, without depending on the internal dedup
 * store. Used to assert alert semantics in tests.
 */
export function buildExpectedDedupKey(
  method: string,
  route: string,
  kind: SloBurnResult['kind'],
): string {
  return `${sloConfigKey(method, route)}:${kind}`;
}
