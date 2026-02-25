import { Settlement, SettlementStore } from '../types/developer.js';

export class InMemorySettlementStore implements SettlementStore {
  private settlements: Settlement[] = [];

  create(settlement: Settlement): void {
    this.settlements.push(settlement);
  }

  updateStatus(id: string, status: Settlement['status'], txHash?: string): void {
    const s = this.settlements.find((s) => s.id === id);
    if (s) {
      s.status = status;
      if (txHash !== undefined) {
        s.tx_hash = txHash;
      }
    }
  }

  getDeveloperSettlements(developerId: string): Settlement[] {
    return this.settlements
      .filter((s) => s.developerId === developerId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  /** Helper for tests */
  clear(): void {
    this.settlements = [];
  }
}

export function createSettlementStore(): InMemorySettlementStore {
  return new InMemorySettlementStore();
}
