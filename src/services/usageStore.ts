import { UsageStore, UsageEvent } from '../types/gateway.js';

/**
 * In-memory usage event store with idempotency.
 * In production this would write to a database table.
 */
export class InMemoryUsageStore implements UsageStore {
  private events: UsageEvent[] = [];
  private requestIds = new Set<string>();

  /**
   * Record a usage event.
   * Returns false if an event with the same requestId already exists (idempotent).
   */
  record(event: UsageEvent): boolean {
    if (this.requestIds.has(event.requestId)) {
      return false; // duplicate — skip
    }
    this.requestIds.add(event.requestId);
    this.events.push(event);
    return true;
  }

  /** Check if an event with this requestId has been recorded. */
  hasEvent(requestId: string): boolean {
    return this.requestIds.has(requestId);
  }

  getEvents(apiKey?: string): UsageEvent[] {
    if (apiKey) {
      return this.events.filter((e) => e.apiKey === apiKey);
    }
    return [...this.events];
  }

  /** Retrieve all usage events that haven't been settled yet and have a non-zero price. */
  getUnsettledEvents(): UsageEvent[] {
    return this.events.filter((e) => !e.settlementId && e.amountUsdc > 0);
  }

  /** Mark a specific set of events as settled. */
  markAsSettled(eventIds: string[], settlementId: string): void {
    const ids = new Set(eventIds);
    for (const event of this.events) {
      if (ids.has(event.id)) {
        event.settlementId = settlementId;
      }
    }
  }

  /** Helper for tests — clear all events. */
  clear(): void {
    this.events = [];
    this.requestIds.clear();
  }
}

export function createUsageStore(): InMemoryUsageStore {
  return new InMemoryUsageStore();
}

interface UsageStoreClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface UsageStoreQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  connect(): Promise<UsageStoreClient>;
}

interface UsageEventRow {
  id: string | number;
  request_id: string;
  api_key: string | null;
  api_key_id: string;
  api_id: string;
  endpoint_id: string;
  user_id: string;
  amount_usdc: string | number;
  status_code: number;
  created_at: Date | string;
  settlement_external_id: string | null;
}

const toNumber = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value);

const mapUsageEventRow = (row: UsageEventRow): UsageEvent => ({
  id: String(row.id),
  requestId: row.request_id,
  apiKey: row.api_key ?? row.api_key_id,
  apiKeyId: row.api_key_id,
  apiId: row.api_id,
  endpointId: row.endpoint_id,
  userId: row.user_id,
  amountUsdc: toNumber(row.amount_usdc),
  statusCode: row.status_code,
  timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  settlementId: row.settlement_external_id ?? undefined,
});

const usageEventSelect = `
  SELECT
    ue.id,
    ue.request_id,
    ue.api_key,
    ue.api_key_id,
    ue.api_id,
    ue.endpoint_id,
    rl.developer_id AS user_id,
    ue.amount_usdc,
    ue.status_code,
    ue.created_at,
    s.external_id AS settlement_external_id
  FROM usage_events ue
  INNER JOIN revenue_ledger rl
    ON rl.usage_event_id = ue.id
  LEFT JOIN settlements s
    ON s.id = rl.settlement_id
`;

export class PostgresUsageStore implements UsageStore {
  constructor(private readonly db: UsageStoreQueryable) {}

  async record(event: UsageEvent): Promise<boolean> {
    if (await this.hasEvent(event.requestId)) {
      return false;
    }

    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      const insertResult = await client.query<{ id: string | number }>(
        `
          INSERT INTO usage_events (
            user_id,
            api_id,
            endpoint_id,
            api_key_id,
            api_key,
            amount_usdc,
            request_id,
            status_code,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (request_id) DO NOTHING
          RETURNING id
        `,
        [
          event.userId,
          event.apiId,
          event.endpointId,
          event.apiKeyId,
          event.apiKey,
          event.amountUsdc,
          event.requestId,
          event.statusCode,
          event.timestamp,
        ],
      );

      const inserted = insertResult.rows[0];
      if (!inserted) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `
          INSERT INTO revenue_ledger (
            api_id,
            developer_id,
            amount_usdc,
            usage_event_id,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (usage_event_id) DO NOTHING
        `,
        [
          event.apiId,
          event.userId,
          event.amountUsdc,
          inserted.id,
          event.timestamp,
        ],
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async hasEvent(requestId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: number }>(
      'SELECT 1 AS exists FROM usage_events WHERE request_id = $1 LIMIT 1',
      [requestId],
    );
    return Boolean(result.rows[0]);
  }

  async getEvents(apiKey?: string): Promise<UsageEvent[]> {
    const params: unknown[] = [];
    const where = apiKey ? 'WHERE ue.api_key = $1 OR ue.api_key_id = $1' : '';
    if (apiKey) {
      params.push(apiKey);
    }

    const result = await this.db.query<UsageEventRow>(
      `
        ${usageEventSelect}
        ${where}
        ORDER BY ue.created_at ASC, ue.id ASC
      `,
      params,
    );

    return result.rows.map(mapUsageEventRow);
  }

  async getUnsettledEvents(): Promise<UsageEvent[]> {
    const result = await this.db.query<UsageEventRow>(
      `
        ${usageEventSelect}
        WHERE rl.settlement_id IS NULL
          AND ue.amount_usdc > 0
        ORDER BY ue.created_at ASC, ue.id ASC
      `,
    );

    return result.rows.map(mapUsageEventRow);
  }

  async markAsSettled(eventIds: string[], settlementId: string): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }

    const settlementResult = await this.db.query<{ id: string | number }>(
      `
        SELECT id
        FROM settlements
        WHERE external_id = $1
        LIMIT 1
      `,
      [settlementId],
    );

    const persistedSettlementId = settlementResult.rows[0]?.id;
    if (persistedSettlementId === undefined) {
      return;
    }

    const eventIdParams = eventIds.map((id) => Number(id));
    const placeholders = eventIdParams.map((_, index) => `$${index + 2}`).join(', ');

    await this.db.query(
      `
        UPDATE revenue_ledger
        SET settlement_id = $1
        WHERE usage_event_id IN (${placeholders})
      `,
      [persistedSettlementId, ...eventIdParams],
    );
  }
}

export function createPostgresUsageStore(db: UsageStoreQueryable): PostgresUsageStore {
  return new PostgresUsageStore(db);
}
