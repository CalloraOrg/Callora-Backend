import { logger } from '../logger.js';
import {
  withRetry,
  TransientError,
  RETRIABLE_HTTP_STATUSES,
  isTransientNetworkError,
} from '../lib/retry.js';

export interface ReconciliationQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type DiscrepancyType =
  | 'MISSING_TX'
  | 'STALE_PENDING'
  | 'FALSE_FAILURE'
  | 'UNEXPECTED_STATUS';

export interface SettlementDiscrepancy {
  settlementId: string;
  developerId: string;
  type: DiscrepancyType;
  dbStatus: string;
  horizonStatus: string | null;
  txHash: string;
  amount: number;
  created_at: string;
}

export interface SettlementReconciliationResult {
  runAt: Date;
  checked: number;
  ok: number;
  discrepancies: SettlementDiscrepancy[];
  errors: number;
}

export interface SettlementReconciliationJobOptions {
  horizonUrl: string;
  horizonRequestTimeoutMs?: number;
  horizonMaxRetries?: number;
  horizonRetryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

interface SettlementRow {
  external_id: string;
  developer_id: string;
  amount_usdc: string | number;
  status: string;
  stellar_tx_hash: string | null;
  created_at: Date | string;
}

interface HorizonTransactionResponse {
  successful?: boolean;
  status?: string;
}

export class SettlementReconciliationJob {
  private readonly log: Pick<typeof logger, 'info' | 'warn' | 'error'>;

  constructor(
    private readonly db: ReconciliationQueryable,
    private readonly options: SettlementReconciliationJobOptions,
  ) {
    this.log = options.logger ?? logger;
  }

  async runOnce(): Promise<SettlementReconciliationResult> {
    const runAt = new Date();
    const horizonUrl = this.options.horizonUrl;
    let checked = 0;
    let ok = 0;
    const discrepancies: SettlementDiscrepancy[] = [];
    let errors = 0;

    const rows = await this.fetchSettlementsWithTxHash();

    for (const row of rows) {
      const txHash = row.stellar_tx_hash;
      if (!txHash) continue;

      checked++;

      try {
        const horizonResponse = await this.fetchHorizonTransactionStatus(txHash, horizonUrl);

        const dbStatus = row.status;
        const discrepancy = this.classifyDiscrepancy(row, txHash, dbStatus, horizonResponse);

        if (discrepancy) {
          discrepancies.push(discrepancy);
          this.log.warn('Settlement reconciliation discrepancy', {
            settlementId: row.external_id,
            developerId: row.developer_id,
            type: discrepancy.type,
            dbStatus,
            horizonStatus: discrepancy.horizonStatus,
            txHash,
          });
        } else {
          ok++;
        }
      } catch (error) {
        errors++;
        this.log.error('Settlement reconciliation check failed', {
          settlementId: row.external_id,
          txHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.log.info('Settlement reconciliation run complete', {
      runAt: runAt.toISOString(),
      checked,
      ok,
      discrepancies: discrepancies.length,
      errors,
    });

    return { runAt, checked, ok, discrepancies, errors };
  }

  private async fetchSettlementsWithTxHash(): Promise<SettlementRow[]> {
    const result = await this.db.query<SettlementRow>(
      `SELECT
        external_id,
        developer_id,
        amount_usdc,
        status,
        stellar_tx_hash,
        created_at
      FROM settlements
      WHERE stellar_tx_hash IS NOT NULL
      ORDER BY created_at ASC`,
    );
    return result.rows;
  }

  private async fetchHorizonTransactionStatus(
    txHash: string,
    horizonUrl: string,
  ): Promise<HorizonTransactionResponse | null> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const maxRetries = this.options.horizonMaxRetries ?? 2;
    const baseDelayMs = this.options.horizonRetryBaseDelayMs ?? 100;
    const timeoutMs = this.options.horizonRequestTimeoutMs ?? 5000;

    return withRetry(
      async () => {
        const url = `${horizonUrl.endsWith('/') ? horizonUrl : horizonUrl + '/'}transactions/${txHash}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetchImpl(url, { signal: controller.signal });

          if (response.status === 404) {
            return null;
          }

          if (!response.ok) {
            if (RETRIABLE_HTTP_STATUSES.has(response.status)) {
              throw new TransientError(`Horizon returned ${response.status}`);
            }
            throw new Error(`Horizon returned ${response.status}`);
          }

          const data = await response.json() as HorizonTransactionResponse;
          return data;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxAttempts: maxRetries + 1,
        baseDelayMs,
        shouldRetry: isTransientNetworkError,
      },
    );
  }

  private classifyDiscrepancy(
    row: SettlementRow,
    txHash: string,
    dbStatus: string,
    horizonResponse: HorizonTransactionResponse | null,
  ): SettlementDiscrepancy | null {
    if (horizonResponse === null) {
      if (dbStatus === 'completed') {
        return {
          settlementId: row.external_id,
          developerId: row.developer_id,
          type: 'MISSING_TX',
          dbStatus,
          horizonStatus: 'not_found',
          txHash,
          amount: Number(row.amount_usdc),
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        };
      }
      if (dbStatus === 'pending' || dbStatus === 'retryable') {
        return null;
      }
      return {
        settlementId: row.external_id,
        developerId: row.developer_id,
        type: 'UNEXPECTED_STATUS',
        dbStatus,
        horizonStatus: 'not_found',
        txHash,
        amount: Number(row.amount_usdc),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      };
    }

    const onChainSuccessful = horizonResponse.successful === true;

    if (dbStatus === 'completed' && !onChainSuccessful) {
      return {
        settlementId: row.external_id,
        developerId: row.developer_id,
        type: 'MISSING_TX',
        dbStatus,
        horizonStatus: onChainSuccessful === false ? 'failed' : 'unknown',
        txHash,
        amount: Number(row.amount_usdc),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      };
    }

    if (dbStatus === 'failed' && onChainSuccessful) {
      return {
        settlementId: row.external_id,
        developerId: row.developer_id,
        type: 'FALSE_FAILURE',
        dbStatus,
        horizonStatus: 'successful',
        txHash,
        amount: Number(row.amount_usdc),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      };
    }

    if ((dbStatus === 'pending' || dbStatus === 'retryable') && onChainSuccessful) {
      return {
        settlementId: row.external_id,
        developerId: row.developer_id,
        type: 'STALE_PENDING',
        dbStatus,
        horizonStatus: 'successful',
        txHash,
        amount: Number(row.amount_usdc),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      };
    }

    if (dbStatus === 'completed' && onChainSuccessful) {
      return null;
    }

    if ((dbStatus === 'pending' || dbStatus === 'retryable') && horizonResponse.successful === false) {
      return null;
    }

    if (dbStatus === 'failed' && !onChainSuccessful) {
      return null;
    }

    return null;
  }
}

export interface SettlementReconciliationScheduledOptions
  extends SettlementReconciliationJobOptions {
  intervalMs: number;
}

export interface ScheduledSettlementReconciliationJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createSettlementReconciliationJob(
  db: ReconciliationQueryable,
  options: SettlementReconciliationScheduledOptions,
): ScheduledSettlementReconciliationJob {
  const log = options.logger ?? logger;

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer.');
  }

  const job = new SettlementReconciliationJob(db, options);
  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<SettlementReconciliationResult> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) return;

    running = job.runOnce();
    try {
      await running;
    } catch (err) {
      log.error('Settlement reconciliation job failed:', err);
    } finally {
      running = null;
    }
  };

  return {
    start() {
      if (timer || !accepting) return;
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs);
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
      if (running) await running.catch(() => undefined);
    },
  };
}
