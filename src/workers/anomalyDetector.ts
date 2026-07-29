import type { Pool } from 'pg';
import { logger } from '../logger.js';
import {
  createAnomalyDedupStore,
  runAnomalyScan,
  type AnomalyDetectionConfig,
  type AnomalyDedupStore,
} from '../services/anomalyService.js';

export interface AnomalyDetectorOptions {
  intervalMs: number;
  config: AnomalyDetectionConfig;
  dedupWindowMs?: number;
  logger?: Pick<typeof logger, 'error' | 'info'>;
  dedup?: AnomalyDedupStore;
}

export interface AnomalyDetectorJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createAnomalyDetectorJob(
  pool: Pool,
  options: AnomalyDetectorOptions,
): AnomalyDetectorJob {
  const log = options.logger ?? logger;

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer');
  }

  const dedup =
    options.dedup ??
    createAnomalyDedupStore(options.dedupWindowMs ?? options.config.windowMs);

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = (async () => {
      try {
        await runAnomalyScan({
          pool,
          config: options.config,
          dedup,
          log,
        });
      } catch (error) {
        log.error('[anomalyDetector] Job failed', { error });
      } finally {
        running = null;
      }
    })();

    await running;
  };

  return {
    start() {
      if (timer || !accepting) {
        return;
      }
      void tick();
      timer = setInterval(() => {
        void tick();
      }, options.intervalMs);
    },

    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },

    beginShutdown() {
      accepting = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async awaitIdle() {
      await (running ?? Promise.resolve());
    },
  };
}
