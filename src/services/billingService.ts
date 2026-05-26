import { BillingService, BillingResult, UsageChargeRequest, UsageChargeResult } from '../types/gateway.js';

/**
 * In-memory mock of the Soroban billing contract.
 * Maintains per-developer balances; deductions succeed when balance >= amount.
 */
export class MockSorobanBilling implements BillingService {
  private balances: Map<string, number>;
  private processedUsageCharges = new Map<string, UsageChargeResult>();
  private nextUsageChargeFailure:
    | { error: string; reconciliationRequired: boolean }
    | null = null;

  constructor(initialBalances?: Record<string, number>) {
    this.balances = new Map(Object.entries(initialBalances ?? {}));
  }

  async deductCredit(developerId: string, amount: number): Promise<BillingResult> {
    if (amount <= 0) {
      return { success: false, balance: this.balances.get(developerId) ?? 0 };
    }

    const current = this.balances.get(developerId) ?? 0;

    if (current < amount) {
      return { success: false, balance: current };
    }

    const newBalance = current - amount;
    this.balances.set(developerId, newBalance);
    return { success: true, balance: newBalance };
  }

  async checkBalance(developerId: string): Promise<number> {
    return this.balances.get(developerId) ?? 0;
  }

  async chargeUsage(request: UsageChargeRequest): Promise<UsageChargeResult> {
    const existing = this.processedUsageCharges.get(request.requestId);
    if (existing) {
      return {
        ...existing,
        alreadyProcessed: true,
      };
    }

    if (this.nextUsageChargeFailure) {
      const failure = this.nextUsageChargeFailure;
      this.nextUsageChargeFailure = null;
      return {
        success: false,
        balance: this.balances.get(request.developerId) ?? 0,
        alreadyProcessed: false,
        reconciliationRequired: failure.reconciliationRequired,
        error: failure.error,
      };
    }

    const deduction = await this.deductCredit(request.developerId, request.amountUsdc);
    const result: UsageChargeResult = {
      ...deduction,
      alreadyProcessed: false,
      reconciliationRequired: false,
    };

    if (result.success) {
      this.processedUsageCharges.set(request.requestId, result);
    }

    return result;
  }

  /** Helper for tests — set a developer's balance directly. */
  setBalance(developerId: string, amount: number): void {
    this.balances.set(developerId, amount);
  }

  getBalance(developerId: string): number {
    return this.balances.get(developerId) ?? 0;
  }

  failNextUsageCharge(error: string, reconciliationRequired = true): void {
    this.nextUsageChargeFailure = { error, reconciliationRequired };
  }

  clear(): void {
    this.processedUsageCharges.clear();
    this.nextUsageChargeFailure = null;
  }
}

export function createBillingService(
  initialBalances?: Record<string, number>,
): MockSorobanBilling {
  return new MockSorobanBilling(initialBalances);
}
