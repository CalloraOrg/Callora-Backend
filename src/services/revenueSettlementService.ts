import { Settlement, SettlementStore } from '../types/developer.js';
import { ApiRegistry, UsageEvent, UsageStore } from '../types/gateway.js';
import { SorobanSettlementClient } from './sorobanSettlement.js';
import { randomUUID } from 'node:crypto';

export interface RevenueSettlementOptions {
  /** Minimum accumulated USDC to trigger a payout (default: 5.00) */
  minPayoutUsdc?: number;
  /** Maximum number of events to process per developer per batch (to avoid hitting transaction limits) */
  maxEventsPerBatch?: number;
}

export class RevenueSettlementService {
  private batchTail: Promise<void> = Promise.resolve();

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
    const unsettled = this.usageStore.getUnsettledEvents();
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
        this.settlementStore.create(settlement);
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
          this.settlementStore.updateStatus(settlementId, 'completed', result.txHash);
          this.usageStore.markAsSettled(eventIds, settlementId);

          processed += events.length;
          settledAmount += totalAmount;
        } catch (error) {
          errors++;
          this.recordFailedSettlement(
            settlementId,
            developerId,
            `Finalization failed after payout: ${this.getErrorMessage(error)}`,
            true,
          );
        }
      } else {
        // Failed: record failure, do NOT mark events as settled so they retry next batch
        errors++;
        this.recordFailedSettlement(settlementId, developerId, result.error);
      }
    }

    return { processed, settledAmount, errors };
  }

  private recordFailedSettlement(
    settlementId: string,
    developerId: string,
    errorMessage?: string,
    clearTxHash = false,
  ): void {
    try {
      this.settlementStore.updateStatus(
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
