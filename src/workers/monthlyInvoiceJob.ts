import type { Pool } from "pg";
import { logger } from "../logger.js";
import { InvoiceService } from "../services/InvoiceService.js";
import { previousUtcMonthPeriod } from "../lib/periods.js";

export interface MonthlyInvoiceJobOptions {
  intervalMs: number;
  graceMs?: number;
  clock?: () => Date;
  logger?: Pick<typeof logger, "error" | "info">;
}

export interface MonthlyInvoiceJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createMonthlyInvoiceJob(
  pool: Pool,
  options: MonthlyInvoiceJobOptions,
): MonthlyInvoiceJob {
  const log = options.logger ?? logger;
  const invoiceService = new InvoiceService(pool);
  const graceMs = options.graceMs ?? 3_600_000;
  const clock = options.clock ?? (() => new Date());

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("intervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error("graceMs must be a non-negative safe integer");
  }

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = Promise.resolve().then(async () => {
      try {
        const now = clock();
        const period = previousUtcMonthPeriod(now);
        const { periodId } = period;

        if (now.getTime() - period.end.getTime() < graceMs) {
          log.info(
            "[monthlyInvoice] Waiting for month-end grace period",
          );
          return;
        }

        log.info("[monthlyInvoice] Starting invoice generation", { periodId });

        const result = await invoiceService.generateMonthlyInvoices(period);

        log.info("[monthlyInvoice] Invoice generation complete", {
          periodId,
          success: result.success,
          invoicesCreated: result.invoicesCreated,
        });
      } catch (error) {
        log.error("[monthlyInvoice] Job failed", { error });
      }
    });

    try {
      await running;
    } finally {
      running = null;
    }
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
