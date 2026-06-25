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

export interface ReconcileResult {
  checked: number;
  completed: number;
  failed: number;
  errors: number;
}

interface HorizonTransactionResponse {
  successful?: boolean;
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

      // 3. Update settlement status and events
      if (result.success && result.txHash) {
        try {
          await this.settlementStore.updateStatus(settlementId, 'completed', result.txHash);
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
      return await this.reconcileOnce();
    } finally {
      releaseReconcile();
    }
  }

  private async reconcileOnce(): Promise<ReconcileResult> {
    const pendingSettlements = await this.settlementStore.listPending?.() ?? [];

    const result: ReconcileResult = { checked: 0, completed: 0, failed: 0, errors: 0 };

    if (pendingSettlements.length === 0) return result;

    const horizonBase = (this.options.horizonUrl ?? 'https://horizon-testnet.stellar.org/').replace(/\/$/, '');
    const fetchFn = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.horizonRequestTimeoutMs ?? 10_000;
    const maxRetries = this.options.horizonMaxRetries ?? 3;
    const retryBaseDelayMs = this.options.horizonRetryBaseDelayMs ?? 500;

    for (const settlement of pendingSettlements) {
      if (!settlement.tx_hash) continue;

      result.checked++;

      try {
        const horizonResult = await withRetry(
          async () => {
            const url = `${horizonBase}/transactions/${encodeURIComponent(settlement.tx_hash!)}`;
            const res = await fetchFn(url, {
              signal: AbortSignal.timeout(timeoutMs),
            });

            // 404 → transaction not found → treat as failed (not retriable)
            if (res.status === 404) {
              return { found: false, successful: false } as const;
            }

            // Transient server errors → throw so withRetry can back off
            if (RETRIABLE_HTTP_STATUSES.has(res.status)) {
              throw new TransientError(`Horizon returned ${res.status}`);
            }

            const body = await res.json() as HorizonTransactionResponse;
            return { found: true, successful: body.successful === true } as const;
          },
          {
            maxAttempts: maxRetries + 1,
            baseDelayMs: retryBaseDelayMs,
            shouldRetry: isTransientNetworkError,
          },
        );

        if (horizonResult.successful) {
          await this.settlementStore.updateStatus(settlement.id, 'completed', settlement.tx_hash);
          const now = new Date().toISOString();
          // Best-effort: set completed_at if the store supports it
          const store = this.settlementStore as SettlementStore & {
            setCompletedAt?: (id: string, completedAt: string) => void;
          };
          store.setCompletedAt?.(settlement.id, now);
          result.completed++;
        } else {
          await this.settlementStore.updateStatus(settlement.id, 'failed', undefined);
          result.failed++;
        }
      } catch (error) {
        // Transient errors exhausted retries — leave status as pending for next run
        result.errors++;
        console.error(
          `[reconcile] Failed to check Horizon status for settlement ${settlement.id}:`,
          this.getErrorMessage(error),
        );
      }
    }

    return result;
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
