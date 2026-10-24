import { Settlement, SettlementStore } from '../types/developer.js';
import { ApiRegistry, UsageEvent, UsageStore } from '../types/gateway.js';
import { SorobanSettlementClient } from './sorobanSettlement.js';
import { randomUUID } from 'node:crypto';
import { calloraEvents } from '../events/event.emitter.js';
import {
  computeJitteredDelay,
  RETRIABLE_HTTP_STATUSES,
  TransientError,
  isTransientNetworkError,
  withRetry,
} from '../lib/retry.js';
import { parseUsdcToUnits, formatUnitsToUsdcFixed } from '../lib/usdcUnits.js';
import { env } from '../config/env.js';

const TX_FAILED_TOO_EARLY = 'tx_failed_too_early';

export interface RevenueSettlementOptions {
  /** Minimum accumulated USDC to trigger a payout (default: 5.00) */
  minPayoutUsdc?: number;
  /** Maximum number of events to process per developer per batch (to avoid hitting transaction limits) */
  maxEventsPerBatch?: number;
  horizonUrl?: string;
  fetchImpl?: typeof fetch;
  horizonRequestTimeoutMs?: number;
  /** Maximum retry attempts for transient Horizon errors (default: 3). */
  horizonMaxRetries?: number;
  /** Base delay in ms for Horizon retry backoff (default: 500). */
  horizonRetryBaseDelayMs?: number;
  /** How long to wait before re-checking a tx_failed_too_early settlement, in ms (default: 30000). */
  tooEarlyBackoffMs?: number;
  /** Maximum tx_failed_too_early retries before permanently failing a settlement (default: 5). */
  maxTooEarlyRetries?: number;
}

/**
 * Horizon transaction response type.
 */
export interface ReconcileResult {
  checked: number;
  completed: number;
  failed: number;
  retried: number;
  errors: number;
}

interface HorizonTransactionResponse {
  successful?: boolean;
  status?: string;
  result_codes?: {
    transaction?: string;
    operations?: string[];
  };
}

export class RevenueSettlementService {
  private batchTail: Promise<void> = Promise.resolve();
  private reconcileTail: Promise<void> = Promise.resolve();

  constructor(
    private usageStore: UsageStore,
    private settlementStore: SettlementStore,
    private apiRegistry: ApiRegistry,
    private settlementClient: SorobanSettlementClient,
    private options: RevenueSettlementOptions = {},
  ) { }

  /**
   * Run a settlement batch.
   * 1. Finds all unsettled events with amount > 0.
   * 2. Resolves each event's API to its developerId.
   * 3. Groups by developer, applying max batch size.
   * 4. For each developer meeting min payout, creates a settlement + calls distribute().
   */
  async runBatch(): Promise<{ processed: number; settledAmount: bigint; errors: number }> {
    const previousBatch = this.batchTail.catch(() => undefined);
    let releaseBatch!: () => void;
    this.batchTail = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    await previousBatch;

    try {
      return await this.runBatchOnce();
    } finally {
      releaseBatch();
    }
  }

  private async runBatchOnce(): Promise<{ processed: number; settledAmount: bigint; errors: number }> {
    const unsettled = await this.usageStore.getUnsettledEvents();
    if (unsettled.length === 0) {
      return { processed: 0, settledAmount: 0n, errors: 0 };
    }

    // Convert minPayoutUsdc option (a float like 5.0) to bigint contract units.
    const rawMinPayout = this.options.minPayoutUsdc ?? 5.0;
    const minPayout = parseUsdcToUnits(rawMinPayout.toFixed(7));
    const maxEvents = this.options.maxEventsPerBatch ?? 1000;

    // Group events by developerId
    const devEvents = new Map<string, UsageEvent[]>();

    for (const event of unsettled) {
      if (event.amountUsdc <= 0n) continue;

      const apiEntry = this.apiRegistry.resolve(event.apiId);
      if (!apiEntry) {
        // Orphaned event, can't settle without knowing the developer
        continue;
      }

      const devId = apiEntry.developerId;
      const group = devEvents.get(devId) ?? [];

      // Enforce batch size limit per developer
      if (group.length < maxEvents) {
        group.push(event);
        devEvents.set(devId, group);
      }
    }

    let processed = 0;
    let settledAmount = 0n;
    let errors = 0;

    for (const [developerId, events] of devEvents.entries()) {
      const totalAmount = events.reduce((sum, e) => sum + e.amountUsdc, 0n);

      if (totalAmount < minPayout) {
        // Skip for now, let it accumulate for the next batch
        continue;
      }

      const settlementId = `stl_${randomUUID()}`;
      const eventIds = events.map((e) => e.id);

      // 1. Create pending settlement record in DB (idempotency start)
      const settlement: Settlement = {
        id: settlementId,
        developerId,
        amount: totalAmount,
        status: 'pending',
        tx_hash: null,
        created_at: new Date().toISOString(),
      };
      try {
        await this.settlementStore.create(settlement);
      } catch (error) {
        errors++;
        console.error(
          `Settlement ${settlementId} failed for dev ${developerId}:`,
          this.getErrorMessage(error)
        );
        continue;
      }

      // 2. Call contract — pass bigint contract units directly.
      let result;

      try {
        result = await this.settlementClient.distribute(developerId, totalAmount);
      } catch (error) {
        result = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown settlement client failure',
        };
      }

      // 3. Record the submitted tx hash and mark events settled.
      if (result.success && result.txHash) {
        try {
          await this.settlementStore.updateStatus(settlementId, 'pending', result.txHash);
          await this.usageStore.markAsSettled(eventIds, settlementId);

          await this.emitSettlementCompleted(
            settlementId,
            developerId,
            totalAmount,
            result.txHash,
          );

          processed += events.length;
          settledAmount += totalAmount;
        } catch (error) {
          errors++;
          await this.recordFailedSettlement(
            settlementId,
            developerId,
            `Finalization failed after payout: ${this.getErrorMessage(error)}`,
            true,
          );
        }
      } else {
        // Failed: record failure, do NOT mark events as settled so they retry next batch
        errors++;
        await this.recordFailedSettlement(settlementId, developerId, result.error);
      }
    }

    return { processed, settledAmount, errors };
  }

  /**
   * Reconcile all pending settlements by checking their transaction status on Horizon.
   */
  async reconcilePendingSettlements(): Promise<ReconcileResult> {
    const previousReconcile = this.reconcileTail.catch(() => undefined);
    let releaseReconcile!: () => void;
    this.reconcileTail = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });

    await previousReconcile;

    try {
      return await this.reconcilePendingSettlementsOnce();
    } finally {
      releaseReconcile();
    }
  }

  private async reconcilePendingSettlementsOnce(): Promise<ReconcileResult> {
    const horizonUrl = this.options.horizonUrl;
    if (!horizonUrl) {
      return { checked: 0, completed: 0, failed: 0, retried: 0, errors: 0 };
    }

    const pendingSettlements = await this.settlementStore.getPendingSettlements();

    let checked = 0;
    let completed = 0;
    let failed = 0;
    let retried = 0;
    let errors = 0;

    for (const settlement of pendingSettlements) {
      try {
        checked++;

        const horizonResponse = await this.fetchHorizonTransactionStatus(settlement.tx_hash!);

        const resultCodes = horizonResponse?.result_codes;
        const transactionCode = resultCodes?.transaction;

        if (horizonResponse?.successful === true) {
          try {
            await this.settlementStore.updateStatus(settlement.id, 'completed');
            completed++;
          } catch (updateError) {
            errors++;
            console.warn(
              { settlementId: settlement.id, error: updateError },
              'Failed to update settlement to completed — skipping',
            );
          }
        } else if (horizonResponse?.successful === false) {
          if (transactionCode === TX_FAILED_TOO_EARLY) {
            const maxRetries = this.options.maxTooEarlyRetries ?? env.SETTLEMENT_MAX_RETRIES;
            const retryCount = settlement.retry_count ?? 0;
            const baseDelayMs = this.options.tooEarlyBackoffMs ?? 30_000;
            const backoffMs = computeJitteredDelay(baseDelayMs * 2 ** retryCount, {
              strategy: 'equal',
              maxDelayMs: 30 * 60_000,
            });
            const retryAfter = new Date(Date.now() + backoffMs).toISOString();
            try {
              const changed = await this.settlementStore.scheduleRetry(
                settlement.id,
                retryAfter,
                maxRetries,
                'Horizon returned tx_failed_too_early after the retry limit was reached',
              );
              if (changed) {
                if (retryCount >= maxRetries) failed++;
                else retried++;
              }
            } catch (updateError) {
              errors++;
              console.warn(
                { settlementId: settlement.id, error: updateError },
                'Failed to schedule retry for settlement — skipping',
              );
            }
          } else {
            try {
              await this.settlementStore.updateStatus(settlement.id, 'failed');
              failed++;
            } catch (updateError) {
              errors++;
              console.warn(
                { settlementId: settlement.id, error: updateError },
                'Failed to update settlement to failed — skipping',
              );
            }

            if (!transactionCode) {
              console.warn(
                { settlementId: settlement.id },
                'Horizon returned tx_failed but missing result_codes',
              );
            }
          }
        } else if (horizonResponse === null) {
          try {
            await this.settlementStore.updateStatus(settlement.id, 'failed');
            failed++;
          } catch (updateError) {
            errors++;
            console.warn(
              { settlementId: settlement.id, error: updateError },
              'Failed to update settlement to failed (not found) — skipping',
            );
          }

          console.warn(
            { settlementId: settlement.id },
            'Horizon did not find transaction',
          );
        } else {
          errors++;
          console.warn(
            { settlementId: settlement.id },
            'Unexpected Horizon response shape — leaving settlement pending',
          );
        }
      } catch (error) {
        errors++;
        console.warn(
          { settlementId: settlement.id, error },
          'Failed to sync settlement status — skipping',
        );
      }
    }

    return { checked, completed, failed, retried, errors };
  }

  private async fetchHorizonTransactionStatus(txHash: string): Promise<HorizonTransactionResponse | null> {
    const horizonUrl = this.options.horizonUrl;
    if (!horizonUrl) {
      throw new Error('Horizon URL not configured');
    }

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

  private async emitSettlementCompleted(
    settlementId: string,
    developerId: string,
    amount: bigint,
    txHash: string,
  ): Promise<void> {
    calloraEvents.emit('settlement_completed', developerId, {
      settlementId,
      // Webhook payload keeps the canonical 7-decimal decimal-string format.
      amount: formatUnitsToUsdcFixed(amount),
      asset: 'USDC',
      txHash,
      settledAt: new Date().toISOString(),
    });
  }

  private async recordFailedSettlement(
    settlementId: string,
    developerId: string,
    errorMessage?: string,
    clearTxHash = false,
  ): Promise<void> {
    try {
      await this.settlementStore.updateStatus(
        settlementId,
        'failed',
        clearTxHash ? null : undefined,
      );
    } catch (statusError) {
      console.error(
        `Settlement ${settlementId} failed for dev ${developerId} and could not persist failure status:`,
        this.getErrorMessage(statusError),
      );
    }

    console.error(
      `Settlement ${settlementId} failed for dev ${developerId}:`,
      errorMessage ?? 'Unknown settlement failure',
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
      return error;
    }

    return 'Unknown settlement failure';
  }
}
