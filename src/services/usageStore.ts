import { UsageStore, UsageEvent, ApiRegistry } from '../types/gateway.js';

const DECIMAL_SCALE = 18;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

function parseToScaledBigInt(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const raw = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toFixed(DECIMAL_SCALE) : '0')
    : String(value).trim();
  if (!raw || raw === '0') return 0n;

  const negative = raw.startsWith('-');
  const unsigned = negative || raw.startsWith('+') ? raw.slice(1) : raw;
  const [intPartRaw = '0', fracPartRaw = ''] = unsigned.split('.');
  const intPart = intPartRaw.replace(/[^0-9]/g, '') || '0';
  const fracPart = fracPartRaw.replace(/[^0-9]/g, '').slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, '0');
  const scaled = BigInt(intPart) * DECIMAL_FACTOR + BigInt(fracPart || '0');
  return negative ? -scaled : scaled;
}

function formatScaledBigInt(scaled: bigint): string {
  if (scaled === 0n) return '0';
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / DECIMAL_FACTOR;
  const fracPart = (abs % DECIMAL_FACTOR).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  const formatted = fracPart.length > 0 ? `${intPart.toString()}.${fracPart}` : intPart.toString();
  return negative ? `-${formatted}` : formatted;
}

export function toDecimalString(value: string | number | null | undefined): string {
  return formatScaledBigInt(parseToScaledBigInt(value));
}

export function addDecimalStrings(...values: Array<string | number | null | undefined>): string {
  let total = 0n;
  for (const val of values) {
    total += parseToScaledBigInt(val);
  }
  return formatScaledBigInt(total);
}

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
  Number(addDecimalStrings(...events.map((event) => event.amountUsdc)));

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
  private apiOwners = new Map<string, string>();
  private apiRegistry?: ApiRegistry;

  constructor(apiRegistry?: ApiRegistry) {
    this.apiRegistry = apiRegistry;
  }

  setApiRegistry(apiRegistry: ApiRegistry): void {
    this.apiRegistry = apiRegistry;
  }

  registerApiOwner(apiId: string, developerId: string): void {
    this.apiOwners.set(apiId, developerId);
  }

  resolveEventOwnerId(event: UsageEvent): string {
    const ownerFromMap = this.apiOwners.get(event.apiId);
    if (ownerFromMap !== undefined) {
      return ownerFromMap;
    }
    const ownerFromRegistry = this.apiRegistry?.resolve(event.apiId)?.developerId;
    if (ownerFromRegistry !== undefined) {
      return ownerFromRegistry;
    }
    if (event.developerId !== undefined) {
      return event.developerId;
    }
    return event.userId;
  }

  /**
   * Record a usage event.
   * Returns false if an event with the same requestId already exists (idempotent).
   */
  record(event: UsageEvent): boolean {
    if (this.requestIds.has(event.requestId)) {
      return false; // duplicate — skip
    }
    this.requestIds.add(event.requestId);
    const resolvedOwner =
      this.apiOwners.get(event.apiId) ??
      this.apiRegistry?.resolve(event.apiId)?.developerId ??
      event.developerId;
    this.events.push(
      resolvedOwner !== undefined ? { ...event, developerId: resolvedOwner } : event,
    );
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
    const events = this.events.filter((event) => this.resolveEventOwnerId(event) === developerId);
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

    const retainedEvents = this.events.filter((event) => this.resolveEventOwnerId(event) !== developerId);
    this.events = retainedEvents;
    this.requestIds = new Set(retainedEvents.map((event) => event.requestId));
    return priorSnapshot;
  }

  /**
   * Retrieve usage events that haven't been settled yet and have a positive price.
   * When developerId is provided, joins/filters by API owner developerId rather than caller userId.
   */
  getUnsettledEvents(developerId?: string): UsageEvent[] {
    return this.events
      .filter((e) => {
        if (e.settlementId || !(e.amountUsdc > 0)) {
          return false;
        }
        if (developerId !== undefined) {
          return this.resolveEventOwnerId(e) === developerId;
        }
        return true;
      })
      .map((e) => ({
        ...e,
        developerId: this.resolveEventOwnerId(e),
      }));
  }

  /**
   * Compute total unsettled revenue for an API owner as an exact decimal string.
   * Joins unsettled events against the API registry / owner map by apiId -> developerId.
   */
  getUnsettledRevenueForDeveloper(developerId: string): string {
    const matching = this.getUnsettledEvents(developerId);
    return addDecimalStrings(...matching.map((e) => e.amountUsdc));
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

export function createUsageStore(apiRegistry?: ApiRegistry): InMemoryUsageStore {
  return new InMemoryUsageStore(apiRegistry);
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
  developer_id?: string;
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
  developerId: row.developer_id ?? row.user_id,
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
    a.developer_id AS user_id,
    a.developer_id AS developer_id,
    ue.amount_usdc,
    ue.status_code,
    ue.created_at,
    s.external_id AS settlement_external_id
  FROM usage_events ue
  INNER JOIN apis a
    ON a.id = ue.api_id
  LEFT JOIN revenue_ledger rl
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
          event.apiKey ?? event.apiKeyId,
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

  async getUnsettledEvents(developerId?: string): Promise<UsageEvent[]> {
    const params: unknown[] = [];
    let ownerClause = '';
    if (developerId !== undefined) {
      params.push(developerId);
      ownerClause = `AND a.developer_id = $1`;
    }

    const result = await this.db.query<UsageEventRow>(
      `
        ${usageEventSelect}
        WHERE rl.settlement_id IS NULL
          AND ue.amount_usdc > 0
          ${ownerClause}
        ORDER BY ue.created_at ASC, ue.id ASC
      `,
      params,
    );

    return result.rows.map(mapUsageEventRow);
  }

  async getUnsettledRevenueForDeveloper(developerId: string): Promise<string> {
    const result = await this.db.query<{ unsettled_amount_usdc: string | number | null }>(
      `
        SELECT
          COALESCE(SUM(ue.amount_usdc::numeric), 0) AS unsettled_amount_usdc
        FROM usage_events ue
        INNER JOIN apis a
          ON a.id = ue.api_id
        LEFT JOIN revenue_ledger rl
          ON rl.usage_event_id = ue.id
        WHERE a.developer_id = $1
          AND rl.settlement_id IS NULL
          AND ue.amount_usdc > 0
      `,
      [developerId],
    );

    return toDecimalString(result.rows[0]?.unsettled_amount_usdc ?? '0');
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
