import type { Pool } from 'pg';
import { logger } from '../logger.js';
import {
  SettlementReconciliationJob,
  type ReconciliationQueryable,
  type SettlementReconciliationJobOptions,
} from '../services/settlementReconciliationJob.js';

/**
 * Settlement reconciliation worker options.
 *
 * Runs nightly reconciliation comparing DB settlement status with on-chain
 * transaction status via Horizon. Detects discrepancies like:
 * - MISSING_TX: completed in DB but not found on-chain
 * - STALE_PENDING: pending in DB but confirmed on-chain
 * - FALSE_FAILURE: marked failed in DB but successful on-chain
 */
export interface SettlementReconWorkerOptions
  extends SettlementReconciliationJobOptions {
  /** Interval between reconciliation runs (default: 86400000ms = 24 hours) */
  intervalMs: number;
  /** Optional logger instance */
  logger?: Pick<typeof logger, 'error' | 'info' | 'warn'>;
}

/**
 * Settlement reconciliation worker interface.
 *
 * Follows the standard DrainableSubsystem pattern with lifecycle hooks
 * for graceful startup and shutdown.
 */
export interface SettlementReconWorker {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

/**
 * Creates a settlement reconciliation worker that periodically scans
 * settlements with transaction hashes and compares their DB status
 * against on-chain Horizon transaction status.
 *
 * @param pool - PostgreSQL connection pool
 * @param options - Worker configuration including interval and Horizon URL
 * @returns Worker instance with lifecycle hooks
 *
 * @example
 * ```typescript
 * const worker = createSettlementReconWorker(pool, {
 *   intervalMs: 86_400_000, // 24 hours
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 *   horizonRequestTimeoutMs: 5_000,
 * });
 *
 * worker.start();
 *
 * // On shutdown:
 * worker.beginShutdown();
 * await worker.awaitIdle();
 * ```
 */
export function createSettlementReconWorker(
  pool: Pool,
  options: SettlementReconWorkerOptions,
): SettlementReconWorker {
  const log = options.logger ?? logger;

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer');
  }

  const db: ReconciliationQueryable = {
    query: (text: string, params?: unknown[]) => pool.query(text, params) as any,
  };

  const job = new SettlementReconciliationJob(db, options);
  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = (async () => {
      try {
        await job.runOnce();
      } catch (error) {
        log.error('[settlementRecon] Job failed', { error });
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
