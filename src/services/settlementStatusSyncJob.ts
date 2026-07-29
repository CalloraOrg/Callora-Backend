import { RevenueSettlementService } from './revenueSettlementService.js';

interface SettlementStatusSyncJobOptions {
  intervalMs: number;
  logger?: Pick<typeof console, 'error'>;
}

export interface SettlementStatusSyncJob {
  start(): void;
  stop(): void;
}

export function createSettlementStatusSyncJob(
  service: RevenueSettlementService,
  options: SettlementStatusSyncJobOptions,
): SettlementStatusSyncJob {
  const logger = options.logger ?? console;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }

    running = true;
    try {
      await service.reconcilePendingSettlements();
    } catch (error) {
      logger.error('Settlement status sync job failed:', error);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) {
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
  };
}
