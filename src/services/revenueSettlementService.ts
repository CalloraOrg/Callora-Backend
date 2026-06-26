import { Settlement, SettlementStore } from '../types/developer.js';
import { ApiRegistry, UsageEvent, UsageStore } from '../types/gateway.js';
import { SorobanSettlementClient } from './sorobanSettlement.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import {
  RETRIABLE_HTTP_STATUSES,
  TransientError,
  isTransientNetworkError,
  withRetry,
} from '../lib/retry.js';

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
}

/**
 * Horizon transaction response type.
 * 
 * Note: result_codes may be missing when Horizon returns a generic error (e.g., tx_failed without
 * details). In such cases, we treat the transaction as failed with an unknown reason. The result_codes.transaction
 * field indicates why the transaction was rejected by Stellar (e.g., 'tx_bad_seq', 'tx_too_large').
 * 
 * When result_codes is missing or transaction field is undefined, we assign status 'failed_unknown'
 * and log at WARN level. This is expected behavior from Horizon and requires investigation in the DB.
 */
export interface ReconcileResult {
  checked: number;
  completed: number;
  failed: number;
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
  async runBatch(): Promise<{ processed: number; settledAmount: number; errors: number }> {
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

  private async runBatchOnce(): Promise<{ processed: number; settledAmount: number; errors: number }> {
    const unsettled = await this.usageStore.getUnsettledEvents();
    if (unsettled.length === 0) {
      return { processed: 0, settledAmount: 0, errors: 0 };
    }

    const minPayout = this.options.minPayoutUsdc ?? 5.0;
    const maxEvents = this.options.maxEventsPerBatch ?? 1000;

    // Group events by developerId
    const devEvents = new Map<string, UsageEvent[]>();

    for (const event of unsettled) {
      if (event.amountUsdc <= 0) continue;

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
    let settledAmount = 0;
    let errors = 0;

    for (const [developerId, events] of devEvents.entries()) {
      const totalAmount = events.reduce((sum, e) => sum + e.amountUsdc, 0);

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

      // 2. Call contract
      // Note: in a real system we would use the developer's registered Soroban address here.
      // For this mock, we just use the developerId as the address string.
      let result;

      try {
        result = await this.settlementClient.distribute(developerId, totalAmount);
      } catch (error) {
        result = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown settlement client failure',
        };
      }

      // 3. Record the submitted tx hash and mark events settled. The settlement
      //    stays 'pending' until reconcilePendingSettlements() confirms the
      //    transaction on Horizon and promotes it to 'completed'.
      if (result.success && result.txHash) {
        try {
          await this.settlementStore.updateStatus(settlementId, 'pending', result.txHash);
          await this.usageStore.markAsSettled(eventIds, settlementId);

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
   * - Marks confirmed transactions as 'completed'.
   * - Marks 404/unsuccessful transactions as 'failed'.
   * - Leaves pending entries unchanged when Horizon returns a transient error (retries with backoff).
   * Returns a summary of the reconciliation pass.
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

  private async reconcilePendingSettlementsOnce(): Promise<{ checked: number; completed: number; failed: number; errors: number }> {
    const horizonUrl = this.options.horizonUrl;
    if (!horizonUrl) {
      // Horizon is not configured; skip reconciliation
      return { checked: 0, completed: 0, failed: 0, errors: 0 };
    }

    const pendingSettlements = await this.settlementStore.getPendingSettlements();

    let checked = 0;
    let completed = 0;
    let failed = 0;
    let errors = 0;

    for (const settlement of pendingSettlements) {
      try {
        checked++;

        // Defensively fetch and parse Horizon response
        const horizonResponse = await this.fetchHorizonTransactionStatus(settlement.tx_hash!);

        // Defensive parsing: result_codes may be missing
        const resultCodes = horizonResponse?.result_codes;
        const transactionCode = resultCodes?.transaction;

        if (horizonResponse?.successful === true) {
          // Transaction confirmed successful
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
          // Transaction explicitly failed
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

          // Log the failure reason if available
          if (!transactionCode) {
            console.warn(
              { settlementId: settlement.id },
              'Horizon returned tx_failed but missing result_codes',
            );
          }
        } else if (horizonResponse === null) {
          // Transaction not found in Horizon — treat as failed
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
          // Unexpected response shape; leave as pending and log warning
          errors++;
          console.warn(
            { settlementId: settlement.id },
            'Unexpected Horizon response shape — leaving settlement pending',
          );
        }
      } catch (error) {
        // Catch any exception during per-settlement processing to continue batch
        errors++;
        console.warn(
          { settlementId: settlement.id, error },
          'Failed to sync settlement status — skipping',
        );
      }
    }

    return { checked, completed, failed, errors };
  }

  /**
   * Fetches transaction status from Horizon, retrying transient errors with backoff.
   * Returns null if transaction is not found (404).
   * Throws only on permanent errors (not retriable).
   */
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
            // Not found is not retriable; transaction doesn't exist
            return null;
          }

          if (!response.ok) {
            // For non-404 errors, check if retriable (5xx or specific 4xx)
            if (RETRIABLE_HTTP_STATUSES.has(response.status)) {
              throw new TransientError(`Horizon returned ${response.status}`);
            }
            // Non-retriable error
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
        this.getErrorMessage(statusError)
      );
    }

    console.error(
      `Settlement ${settlementId} failed for dev ${developerId}:`,
      errorMessage ?? 'Unknown settlement failure'
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

