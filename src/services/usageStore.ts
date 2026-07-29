import { UsageStore, UsageEvent } from '../types/gateway.js';

export interface UsageAggregateSnapshot {
  developerId: string;
  totalEvents: number;
  settledEvents: number;
  unsettledEvents: number;
  totalAmountUsdc: number;
  settledAmountUsdc: number;
  unsettledAmountUsdc: number;
  apiCount: number;
  endpointCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  statusCodes: Record<string, number>;
}

export interface UsageAdminStore extends UsageStore {
  getDeveloperUsageSnapshot(developerId: string): Promise<UsageAggregateSnapshot | undefined> | UsageAggregateSnapshot | undefined;
  resetDeveloperUsage(developerId: string): Promise<UsageAggregateSnapshot | undefined> | UsageAggregateSnapshot | undefined;
}

const emptyStatusCounts = (): Record<string, number> => ({});

const sumAmounts = (events: UsageEvent[]): number =>
  events.reduce((total, event) => total + event.amountUsdc, 0);

const toIsoOrNull = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/**
 * In-memory usage event store with idempotency.
 * In production this would write to a database table.
 */
export class InMemoryUsageStore implements UsageAdminStore {
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

  getDeveloperUsageSnapshot(developerId: string): UsageAggregateSnapshot | undefined {
    const events = this.events.filter((event) => event.userId === developerId);
    if (events.length === 0) {
      return undefined;
    }

    const settledEvents = events.filter((event) => event.settlementId);
    const unsettledEvents = events.filter((event) => !event.settlementId);
    const sortedTimestamps = events
      .map((event) => event.timestamp)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const statusCodes = emptyStatusCounts();

    for (const event of events) {
      const statusCode = String(event.statusCode);
      statusCodes[statusCode] = (statusCodes[statusCode] ?? 0) + 1;
    }

    return {
      developerId,
      totalEvents: events.length,
      settledEvents: settledEvents.length,
      unsettledEvents: unsettledEvents.length,
      totalAmountUsdc: sumAmounts(events),
      settledAmountUsdc: sumAmounts(settledEvents),
      unsettledAmountUsdc: sumAmounts(unsettledEvents),
      apiCount: new Set(events.map((event) => event.apiId)).size,
      endpointCount: new Set(events.map((event) => event.endpointId)).size,
      firstEventAt: sortedTimestamps[0] ?? null,
      lastEventAt: sortedTimestamps[sortedTimestamps.length - 1] ?? null,
      statusCodes,
    };
  }

  resetDeveloperUsage(developerId: string): UsageAggregateSnapshot | undefined {
    const priorSnapshot = this.getDeveloperUsageSnapshot(developerId);
    if (!priorSnapshot) {
      return undefined;
    }

    const retainedEvents = this.events.filter((event) => event.userId !== developerId);
    this.events = retainedEvents;
    this.requestIds = new Set(retainedEvents.map((event) => event.requestId));
    return priorSnapshot;
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

interface UsageAggregateRow {
  total_events: string | number;
  settled_events: string | number;
  unsettled_events: string | number;
  total_amount_usdc: string | number | null;
  settled_amount_usdc: string | number | null;
  unsettled_amount_usdc: string | number | null;
  api_count: string | number;
  endpoint_count: string | number;
  first_event_at: Date | string | null;
  last_event_at: Date | string | null;
}

interface StatusCodeCountRow {
  status_code: number;
  count: string | number;
}

const toNumber = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value);

const nullableNumber = (value: string | number | null): number =>
  value === null ? 0 : toNumber(value);

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

export class PostgresUsageStore implements UsageAdminStore {
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
            developer_id,
            amount_usdc,
            request_id,
            status_code,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, (
            SELECT COALESCE(a.developer_id::text, '')
            FROM apis a WHERE a.id = $2 LIMIT 1
          ), $6, $7, $8, $9)
          ON CONFLICT (request_id, developer_id) DO NOTHING
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
          SELECT
            $1,
            a.developer_id,
            $2::numeric,
            $3::bigint,
            $4::timestamp
          FROM apis a
          WHERE a.id = $1
          ON CONFLICT (usage_event_id) DO NOTHING
        `,
        [
          event.apiId,
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

  async getDeveloperUsageSnapshot(developerId: string): Promise<UsageAggregateSnapshot | undefined> {
    const [aggregateResult, statusResult] = await Promise.all([
      this.db.query<UsageAggregateRow>(
        `
          SELECT
            COUNT(*) AS total_events,
            COUNT(*) FILTER (WHERE rl.settlement_id IS NOT NULL) AS settled_events,
            COUNT(*) FILTER (WHERE rl.settlement_id IS NULL) AS unsettled_events,
            COALESCE(SUM(ue.amount_usdc), 0) AS total_amount_usdc,
            COALESCE(SUM(ue.amount_usdc) FILTER (WHERE rl.settlement_id IS NOT NULL), 0) AS settled_amount_usdc,
            COALESCE(SUM(ue.amount_usdc) FILTER (WHERE rl.settlement_id IS NULL), 0) AS unsettled_amount_usdc,
            COUNT(DISTINCT ue.api_id) AS api_count,
            COUNT(DISTINCT ue.endpoint_id) AS endpoint_count,
            MIN(ue.created_at) AS first_event_at,
            MAX(ue.created_at) AS last_event_at
          FROM revenue_ledger rl
          INNER JOIN usage_events ue
            ON ue.id = rl.usage_event_id
          WHERE rl.developer_id = $1
        `,
        [developerId],
      ),
      this.db.query<StatusCodeCountRow>(
        `
          SELECT ue.status_code, COUNT(*) AS count
          FROM revenue_ledger rl
          INNER JOIN usage_events ue
            ON ue.id = rl.usage_event_id
          WHERE rl.developer_id = $1
          GROUP BY ue.status_code
          ORDER BY ue.status_code ASC
        `,
        [developerId],
      ),
    ]);

    const aggregate = aggregateResult.rows[0];
    if (!aggregate || toNumber(aggregate.total_events) === 0) {
      return undefined;
    }

    const statusCodes = emptyStatusCounts();
    for (const row of statusResult.rows) {
      statusCodes[String(row.status_code)] = toNumber(row.count);
    }

    return {
      developerId,
      totalEvents: toNumber(aggregate.total_events),
      settledEvents: toNumber(aggregate.settled_events),
      unsettledEvents: toNumber(aggregate.unsettled_events),
      totalAmountUsdc: nullableNumber(aggregate.total_amount_usdc),
      settledAmountUsdc: nullableNumber(aggregate.settled_amount_usdc),
      unsettledAmountUsdc: nullableNumber(aggregate.unsettled_amount_usdc),
      apiCount: toNumber(aggregate.api_count),
      endpointCount: toNumber(aggregate.endpoint_count),
      firstEventAt: toIsoOrNull(aggregate.first_event_at),
      lastEventAt: toIsoOrNull(aggregate.last_event_at),
      statusCodes,
    };
  }

  async resetDeveloperUsage(developerId: string): Promise<UsageAggregateSnapshot | undefined> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      const snapshotStore = new PostgresUsageStore({
        query: client.query.bind(client),
        connect: this.db.connect.bind(this.db),
      });
      const priorSnapshot = await snapshotStore.getDeveloperUsageSnapshot(developerId);
      if (!priorSnapshot) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const deletedLedger = await client.query<{ usage_event_id: string | number | null }>(
        `
          DELETE FROM revenue_ledger
          WHERE developer_id = $1
          RETURNING usage_event_id
        `,
        [developerId],
      );

      const usageEventIds = deletedLedger.rows
        .map((row) => row.usage_event_id)
        .filter((id): id is string | number => id !== null && id !== undefined);

      if (usageEventIds.length > 0) {
        await client.query(
          `
            DELETE FROM usage_events ue
            WHERE ue.id = ANY($1::bigint[])
              AND NOT EXISTS (
                SELECT 1
                FROM revenue_ledger rl
                WHERE rl.usage_event_id = ue.id
              )
          `,
          [usageEventIds.map((id) => Number(id))],
        );
      }

      await client.query('COMMIT');
      return priorSnapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
