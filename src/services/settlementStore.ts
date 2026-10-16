import {
  Settlement,
  SettlementStore,
  SettlementPageOptions,
  PaginatedDeveloperSettlements,
} from '../types/developer.js';
import { addDecimalStrings, toDecimalString } from './usageStore.js';

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

  getDeveloperSettlements(developerId: string, options?: SettlementPageOptions): Settlement[] {
    const sorted = this.settlements
      .filter((s) => s.developerId === developerId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (options?.limit !== undefined || options?.offset !== undefined) {
      const offset = Math.max(0, options?.offset ?? 0);
      const limit = options?.limit !== undefined ? Math.max(0, options.limit) : sorted.length;
      return sorted.slice(offset, offset + limit);
    }

    return sorted;
  }

  getDeveloperSettlementsPage(
    developerId: string,
    options: { limit: number; offset: number },
  ): PaginatedDeveloperSettlements {
    const sorted = this.settlements
      .filter((s) => s.developerId === developerId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const offset = Math.max(0, options.offset);
    const limit = Math.max(0, options.limit);
    const settlements = sorted.slice(offset, offset + limit);

    const completedTotal = addDecimalStrings(
      ...sorted.filter((s) => s.status === 'completed' && s.amount > 0).map((s) => s.amount),
    );
    const pendingTotal = addDecimalStrings(
      ...sorted.filter((s) => s.status === 'pending' && s.amount > 0).map((s) => s.amount),
    );

    return {
      settlements,
      total: sorted.length,
      completedTotal,
      pendingTotal,
    };
  }

  scheduleRetry(id: string, retryAfter: string): void {
    const s = this.settlements.find((s) => s.id === id);
    if (s) {
      s.status = 'retryable';
      s.retry_after = retryAfter;
      s.retry_count = (s.retry_count ?? 0) + 1;
    }
  }

  getPendingSettlements(): Settlement[] {
    const now = new Date().toISOString();
    return this.settlements
      .filter(
        (s) =>
          s.status === 'pending' ||
          (s.status === 'retryable' && (s.retry_after == null || s.retry_after <= now)),
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  listPending(): Settlement[] {
    return this.getPendingSettlements();
  }

  setCompletedAt(id: string, completedAt: string): void {
    const s = this.settlements.find((s) => s.id === id);
    if (s) {
      s.completed_at = completedAt;
    }
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
  retry_after?: string | null;
  retry_count?: number | null;
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
  retry_after: row.retry_after ?? null,
  retry_count: row.retry_count ?? 0,
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

  async scheduleRetry(id: string, retryAfter: string): Promise<void> {
    await this.db.query(
      `
        UPDATE settlements
        SET status = 'retryable',
            retry_after = $2,
            retry_count = COALESCE(retry_count, 0) + 1
        WHERE external_id = $1
      `,
      [id, retryAfter],
    );
  }

  async getDeveloperSettlements(
    developerId: string,
    options?: SettlementPageOptions,
  ): Promise<Settlement[]> {
    if (options?.limit !== undefined || options?.offset !== undefined) {
      const limit = Math.max(0, options?.limit ?? 20);
      const offset = Math.max(0, options?.offset ?? 0);
      const result = await this.db.query<SettlementStoreRow>(
        `
          SELECT *
          FROM settlements
          WHERE developer_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
        `,
        [developerId, limit, offset],
      );
      return result.rows.map(mapSettlementRow);
    }

    const result = await this.db.query<SettlementStoreRow>(
      `
        SELECT *
        FROM settlements
        WHERE developer_id = $1
        ORDER BY created_at DESC, id DESC
      `,
      [developerId],
    );

    return result.rows.map(mapSettlementRow);
  }

  async getDeveloperSettlementsPage(
    developerId: string,
    options: { limit: number; offset: number },
  ): Promise<PaginatedDeveloperSettlements> {
    const limit = Math.max(0, options.limit);
    const offset = Math.max(0, options.offset);

    const [pageResult, totalsResult] = await Promise.all([
      this.db.query<SettlementStoreRow>(
        `
          SELECT *
          FROM settlements
          WHERE developer_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
        `,
        [developerId, limit, offset],
      ),
      this.db.query<{
        total: string | number;
        completed_total: string | number | null;
        pending_total: string | number | null;
      }>(
        `
          SELECT
            COUNT(*) AS total,
            COALESCE(SUM(amount_usdc::numeric) FILTER (WHERE status = 'completed' AND amount_usdc > 0), 0) AS completed_total,
            COALESCE(SUM(amount_usdc::numeric) FILTER (WHERE status = 'pending' AND amount_usdc > 0), 0) AS pending_total
          FROM settlements
          WHERE developer_id = $1
        `,
        [developerId],
      ),
    ]);

    const summaryRow = totalsResult.rows[0];
    return {
      settlements: pageResult.rows.map(mapSettlementRow),
      total: toNumber(summaryRow?.total ?? 0),
      completedTotal: toDecimalString(summaryRow?.completed_total ?? '0'),
      pendingTotal: toDecimalString(summaryRow?.pending_total ?? '0'),
    };
  }

  async getPendingSettlements(): Promise<Settlement[]> {
    const result = await this.db.query<SettlementStoreRow>(
      `
        SELECT *
        FROM settlements
        WHERE status = 'pending'
           OR (status = 'retryable' AND (retry_after IS NULL OR retry_after <= NOW()))
        ORDER BY created_at ASC, id ASC
      `,
    );

    return result.rows.map(mapSettlementRow);
  }

  async listPending(): Promise<Settlement[]> {
    return this.getPendingSettlements();
  }

  /**
   * Verify ledger consistency invariants.
   * Returns structured violations found in the settlements table.
   */
  async verifyLedger(): Promise<{
    completedWithoutTxHash: Array<{ external_id: string; developer_id: string; amount_usdc: string; created_at: string }>;
    totalViolations: number;
  }> {
    const result = await this.db.query<SettlementStoreRow & { external_id: string; developer_id: string; amount_usdc: string; created_at: string }>(
      `
        SELECT
          external_id,
          developer_id,
          amount_usdc,
          created_at
        FROM settlements
        WHERE status = 'completed'
          AND stellar_tx_hash IS NULL
        ORDER BY created_at ASC
      `,
    );

    return {
      completedWithoutTxHash: result.rows,
      totalViolations: result.rows.length,
    };
  }
}

export function createPostgresSettlementStore(db: SettlementStoreQueryable): PostgresSettlementStore {
  return new PostgresSettlementStore(db);
}
