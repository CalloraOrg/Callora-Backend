import type { Pool } from 'pg';
import { logger } from '../logger.js';
import {
  recordSlowQueryAlerterRun,
  recordSlowQueryAlerterAlert,
  recordSlowQueryAlerterQueriesAboveThreshold,
} from '../metrics.js';

export interface SlowQueryAlerterOptions {
  webhookUrl: string;
  p95ThresholdMs: number;
  pollIntervalMs: number;
  dedupWindowMs: number;
  logger?: Pick<typeof console, 'error' | 'info' | 'warn'>;
}

export interface SlowQueryEntry {
  fingerprint: string;
  querySample: string;
  calls: number;
  meanExecTime: number;
  maxExecTime: number;
  rows: number;
}

export interface SlowQueryAlerterJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

const POLL_SQL = `
  SELECT
    md5(query)::text AS fingerprint,
    left(query, 200)::text AS query_sample,
    calls,
    mean_exec_time,
    max_exec_time,
    rows
  FROM pg_stat_statements
  WHERE query NOT ILIKE 'DEALLOCATE%'
    AND query NOT ILIKE 'BEGIN%'
    AND query NOT ILIKE 'COMMIT%'
    AND query NOT ILIKE 'ROLLBACK%'
    AND mean_exec_time > $1
  ORDER BY mean_exec_time DESC
  LIMIT 50
`;

export async function fetchSlowQueries(
  pool: Pool,
  thresholdMs: number,
): Promise<SlowQueryEntry[]> {
  const result = await pool.query<SlowQueryEntry>(POLL_SQL, [thresholdMs]);
  return result.rows;
}

export interface DedupStore {
  has(key: string): boolean;
  set(key: string): void;
  cleanup(): void;
}

export function createDedupStore(windowMs: number): DedupStore {
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

function buildAlertPayload(
  queries: SlowQueryEntry[],
  thresholdMs: number,
): object {
  return {
    event: 'slow_query_alert',
    timestamp: new Date().toISOString(),
    data: {
      thresholdMs,
      queryCount: queries.length,
      queries: queries.map((q) => ({
        fingerprint: q.fingerprint,
        querySample: q.querySample,
        calls: q.calls,
        meanExecTimeMs: q.meanExecTime,
        maxExecTimeMs: q.maxExecTime,
        rows: q.rows,
      })),
    },
  };
}

async function postAlert(
  webhookUrl: string,
  payload: object,
  log: Pick<typeof console, 'error' | 'info' | 'warn'>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Callora-SlowQueryAlerter/1.0',
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
        `[slowQueryAlerter] Webhook returned ${response.status}`,
        response.statusText,
      );
    }
  } catch (err) {
    log.error(
      '[slowQueryAlerter] Webhook post failed:',
      (err as Error).message,
    );
  }
}

export function createSlowQueryAlerterJob(
  pool: Pool,
  options: SlowQueryAlerterOptions,
): SlowQueryAlerterJob {
  const log = options.logger ?? logger;

  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error('pollIntervalMs must be a positive integer.');
  }

  if (
    !Number.isFinite(options.p95ThresholdMs) ||
    options.p95ThresholdMs <= 0
  ) {
    throw new Error('p95ThresholdMs must be a positive number.');
  }

  if (
    !Number.isInteger(options.dedupWindowMs) ||
    options.dedupWindowMs <= 0
  ) {
    throw new Error('dedupWindowMs must be a positive integer.');
  }

  if (typeof options.webhookUrl !== 'string' || options.webhookUrl.length === 0) {
    throw new Error('webhookUrl is required');
  }

  const dedup = createDedupStore(options.dedupWindowMs);
  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) return;

    running = (async () => {
      try {
        const queries = await fetchSlowQueries(pool, options.p95ThresholdMs);
        recordSlowQueryAlerterRun();
        recordSlowQueryAlerterQueriesAboveThreshold(queries.length);

        const newQueries = queries.filter((q) => !dedup.has(q.fingerprint));

        for (const q of newQueries) {
          dedup.set(q.fingerprint);
        }

        if (newQueries.length > 0) {
          recordSlowQueryAlerterAlert();
          const payload = buildAlertPayload(newQueries, options.p95ThresholdMs);
          await postAlert(options.webhookUrl, payload, log);
          log.info(
            `[slowQueryAlerter] Alerted for ${newQueries.length} slow ` +
              `queries (threshold: ${options.p95ThresholdMs}ms)`,
          );
        }
      } catch (error) {
        log.error('[slowQueryAlerter] Job failed:', error);
      } finally {
        running = null;
      }
    })();

    await running;
  };

  return {
    start() {
      if (timer || !accepting) return;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, options.pollIntervalMs);
    },

    stop() {
      if (!timer) return;
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
