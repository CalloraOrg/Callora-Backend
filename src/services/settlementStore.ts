import { Settlement, SettlementStore } from '../types/developer.js';

export class InMemorySettlementStore implements SettlementStore {
  private settlements: Settlement[] = [];

  create(settlement: Settlement): void {
    this.settlements.push({
      ...settlement,
      completed_at: settlement.completed_at ?? null,
    });
  }

  updateStatus(id: string, status: Settlement['status'], txHash?: string | null): void {
    const s = this.settlements.find((s) => s.id === id);
    if (s) {
      s.status = status;
      if (txHash !== undefined) {
        s.tx_hash = txHash;
      }
      s.completed_at = status === 'completed' ? new Date().toISOString() : null;
    }
  }

  getDeveloperSettlements(developerId: string): Settlement[] {
    return this.settlements
      .filter((s) => s.developerId === developerId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  getPendingSettlements(): Settlement[] {
    return this.settlements
      .filter((s) => s.status === 'pending')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  /** Helper for tests */
  clear(): void {
    this.settlements = [];
  }
}

export function createSettlementStore(): InMemorySettlementStore {
  return new InMemorySettlementStore();
}

interface SettlementStoreRow {
  external_id: string;
  developer_id: string;
  amount_usdc: string | number;
  status: Settlement['status'];
  stellar_tx_hash: string | null;
  created_at: Date | string;
}

export interface SettlementStoreQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const toNumber = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value);

const mapSettlementRow = (row: SettlementStoreRow): Settlement => ({
  id: row.external_id,
  developerId: row.developer_id,
  amount: toNumber(row.amount_usdc),
  status: row.status,
  tx_hash: row.stellar_tx_hash,
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
});

export class PostgresSettlementStore implements SettlementStore {
  constructor(private readonly db: SettlementStoreQueryable) {}

  async create(settlement: Settlement): Promise<void> {
    await this.db.query(
      `
        INSERT INTO settlements (
          external_id,
          developer_id,
          amount_usdc,
          stellar_tx_hash,
          status,
          created_at,
          completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        settlement.id,
        settlement.developerId,
        settlement.amount,
        settlement.tx_hash,
        settlement.status,
        settlement.created_at,
        settlement.status === 'completed' ? settlement.created_at : null,
      ],
    );
  }

  async updateStatus(id: string, status: Settlement['status'], txHash?: string | null): Promise<void> {
    const setClauses = ['status = $2'];
    const params: unknown[] = [id, status];

    if (txHash !== undefined) {
      params.push(txHash);
      setClauses.push(`stellar_tx_hash = $${params.length}`);
    }

    params.push(status === 'completed' ? new Date() : null);
    setClauses.push(`completed_at = $${params.length}`);

    await this.db.query(
      `
        UPDATE settlements
        SET ${setClauses.join(', ')}
        WHERE external_id = $1
      `,
      params,
    );
  }

  async getDeveloperSettlements(developerId: string): Promise<Settlement[]> {
    const result = await this.db.query<SettlementStoreRow>(
      `
        SELECT
          external_id,
          developer_id,
          amount_usdc,
          status,
          stellar_tx_hash,
          created_at
        FROM settlements
        WHERE developer_id = $1
        ORDER BY created_at DESC, id DESC
      `,
      [developerId],
    );

    return result.rows.map(mapSettlementRow);
  }
}

export function createPostgresSettlementStore(db: SettlementStoreQueryable): PostgresSettlementStore {
  return new PostgresSettlementStore(db);
}
