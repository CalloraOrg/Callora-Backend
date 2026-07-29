import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type {
  RevenueLedgerUsageEvent,
  UsageEventsPgRepository,
} from '../repositories/usageEventsRepository.pg.js';

export interface RevenueLedgerIndexerOptions {
  batchSize?: number;
  logger?: Pick<typeof console, 'error'>;
  resolveDeveloperId?: (apiId: string) => Promise<string | undefined>;
}

export interface RevenueLedgerIndexerRunResult {
  scanned: number;
  inserted: number;
}

export class RevenueLedgerIndexer {
  private readonly batchSize: number;
  private readonly logger: Pick<typeof console, 'error'>;
  private readonly resolveDeveloperId: (apiId: string) => Promise<string | undefined>;
  private runTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly usageEventsRepository: UsageEventsPgRepository,
    options: RevenueLedgerIndexerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error('batchSize must be a positive integer.');
    }

    this.logger = options.logger ?? console;
    this.resolveDeveloperId = options.resolveDeveloperId ?? (async (apiId: string) => {
      const apiResult = await db
        .select({ developer_id: schema.apis.developer_id })
        .from(schema.apis)
        .where(eq(schema.apis.id, Number(apiId)))
        .limit(1);
      return apiResult[0]?.developer_id?.toString();
    });
  }

  async runOnce(): Promise<RevenueLedgerIndexerRunResult> {
    const previousRun = this.runTail.catch(() => undefined);
    let releaseRun!: () => void;
    this.runTail = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    await previousRun;

    try {
      return await this.runOnceInternal();
    } finally {
      releaseRun();
    }
  }

  async awaitIdle(): Promise<void> {
    await this.runTail.catch(() => undefined);
  }

  private async runOnceInternal(): Promise<RevenueLedgerIndexerRunResult> {
    let cursor: string | undefined;
    let scanned = 0;
    let inserted = 0;

    while (true) {
      const events = await this.usageEventsRepository.findUnindexedRevenueLedgerEvents(
        cursor,
        this.batchSize,
      );
      if (events.length === 0) {
        return { scanned, inserted };
      }

      scanned += events.length;
      for (const event of events) {
        inserted += await this.insertEvent(event);
      }

      cursor = events[events.length - 1]?.usageEventId;
    }
  }

  private async insertEvent(event: RevenueLedgerUsageEvent): Promise<number> {
    try {
      const developerId = await this.resolveDeveloperId(event.apiId);

      if (!developerId) {
        this.logger.error('Revenue ledger indexing failed: API or developer not found', { apiId: event.apiId });
        return 0;
      }

      return (await this.usageEventsRepository.indexRevenueLedgerEvent(event, developerId)) ? 1 : 0;
    } catch (error) {
      this.logger.error('Revenue ledger indexing failed for usage event', {
        usageEventId: event.usageEventId,
        error,
      });
      throw error;
    }
  }
}

export interface RevenueLedgerIndexerJobOptions extends RevenueLedgerIndexerOptions {
  intervalMs: number;
}

export interface RevenueLedgerIndexerJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createRevenueLedgerIndexerJob(
  usageEventsRepository: UsageEventsPgRepository,
  options: RevenueLedgerIndexerJobOptions,
): RevenueLedgerIndexerJob {
  const logger = options.logger ?? console;
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer.');
  }

  const indexer = new RevenueLedgerIndexer(usageEventsRepository, options);
  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<RevenueLedgerIndexerRunResult> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = indexer.runOnce();
    try {
      await running;
    } catch (error) {
      logger.error('Revenue ledger indexer job failed:', error);
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
      await (running ?? indexer.awaitIdle());
    },
  };
}
