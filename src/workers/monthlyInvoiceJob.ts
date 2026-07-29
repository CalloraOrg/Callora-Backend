import type { Pool } from "pg";
import { logger } from "../logger.js";
import { InvoiceService } from "../services/InvoiceService.js";

export interface MonthlyInvoiceJobOptions {
  intervalMs: number;
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

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("intervalMs must be a positive integer");
  }

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = (async () => {
      try {
        const now = new Date();

        if (now.getDate() !== 1) {
          log.info(
            "[monthlyInvoice] Not the first day of the month, skipping",
          );
          return;
        }

        const previousMonth = new Date(
          now.getFullYear(),
          now.getMonth() - 1,
          1,
        );
        const periodId = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, "0")}`;

        log.info("[monthlyInvoice] Starting invoice generation", { periodId });

        const result = await invoiceService.generateMonthlyInvoices(periodId);

        log.info("[monthlyInvoice] Invoice generation complete", {
          periodId,
          success: result.success,
          invoicesCreated: result.invoicesCreated,
        });
      } catch (error) {
        log.error("[monthlyInvoice] Job failed", { error });
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
