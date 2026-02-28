export interface PayoutResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface SorobanSettlementClient {
  /** Transfer USDC to developer address. */
  distribute(developerAddress: string, amountUsdc: number): Promise<PayoutResult>;
}

export class MockSorobanSettlementClient implements SorobanSettlementClient {
  private failureRate: number;

  /**
   * @param failureRate 0.0 to 1.0 probability of a mock failure
   */
  constructor(failureRate = 0) {
    this.failureRate = failureRate;
  }

  async distribute(developerAddress: string): Promise<PayoutResult> {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (Math.random() < this.failureRate) {
      return { success: false, error: 'Simulated contract failure' };
    }

    const mockHash = `0xmocktx_${Date.now()}_${developerAddress.substring(0, 4)}`;
    return { success: true, txHash: mockHash };
  }
}

export function createSorobanSettlementClient(failureRate = 0): MockSorobanSettlementClient {
  return new MockSorobanSettlementClient(failureRate);
}
