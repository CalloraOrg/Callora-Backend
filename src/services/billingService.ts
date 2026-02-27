import { BillingService, BillingResult } from '../types/gateway.js';

/**
 * In-memory mock of the Soroban billing contract.
 * Maintains per-developer balances; deductions succeed when balance >= amount.
 */
export class MockSorobanBilling implements BillingService {
  private balances: Map<string, number>;

  constructor(initialBalances?: Record<string, number>) {
    this.balances = new Map(Object.entries(initialBalances ?? {}));
  }

  async deductCredit(developerId: string, amount: number): Promise<BillingResult> {
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

  /** Helper for tests — set a developer's balance directly. */
  setBalance(developerId: string, amount: number): void {
    this.balances.set(developerId, amount);
  }

  getBalance(developerId: string): number {
    return this.balances.get(developerId) ?? 0;
  }
}

export function createBillingService(
  initialBalances?: Record<string, number>,
): MockSorobanBilling {
  return new MockSorobanBilling(initialBalances);
}
