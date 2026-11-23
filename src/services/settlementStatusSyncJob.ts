import { RevenueSettlementService } from './revenueSettlementService.js';

export interface SettlementStatusSyncJobOptions {
  intervalMs: number;
  logger?: Pick<typeof console, 'error'>;
  acquireLock?: () => Promise<boolean>;
  releaseLock?: () => Promise<void>;
}

export interface SettlementStatusSyncJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createSettlementStatusSyncJob(
  service: RevenueSettlementService,
  options: SettlementStatusSyncJobOptions,
): SettlementStatusSyncJob {
  const logger = options.logger ?? console;
  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = (async () => {
      let lockAcquired = false;
      try {
        if (options.acquireLock) {
          lockAcquired = await options.acquireLock();
          if (!lockAcquired) {
            return;
          }
        }
        await service.reconcilePendingSettlements();
      } catch (error) {
        logger.error('Settlement status sync job failed:', error);
      } finally {
        if (lockAcquired && options.releaseLock) {
          try {
            await options.releaseLock();
          } catch (releaseError) {
            logger.error('Settlement status sync job failed to release lock:', releaseError);
          }
        }
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
