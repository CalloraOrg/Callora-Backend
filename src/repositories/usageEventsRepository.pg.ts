import {
  type UsageEventsRepository,
  type UsageEvent,
  type UsageEventQuery,
  type UserUsageEventQuery,
  type UsageStats,
  type UsageBucket,
  type GroupBy,
} from './usageEventsRepository.js';
 feature/usage-cursor-pagination
import { generateCursor, getNextCursor, decodeCursor } from '../lib/pagination.js';
import { readQuery, writeQuery } from '../db.js';
 main

export interface CreateUsageEventInput {
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
  /**
   * Partition key for the hash-partitioned usage_events table.
   * Should be set to the owning developer's ID on every insert.
   * Defaults to '' for backward compatibility but callers should supply this.
   */
  developerId?: string;
  amount: bigint;
  requestId: string;
  stellarTxHash?: string | null;
  createdAt?: Date;
}

export interface BillingUsageEvent {
  id: string;
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
  developerId: string;
  amount: bigint;
  requestId: string;
  stellarTxHash: string | null;
  createdAt: Date;
}

export interface RevenueLedgerUsageEvent {
  usageEventId: string;
  apiId: string;
  amount: bigint;
  createdAt: Date;
}

export interface UsageEventsPgRepository {
  create(event: CreateUsageEventInput): Promise<BillingUsageEvent>;
  findByUserId(userId: string, from?: Date, to?: Date, limit?: number, offset?: number): Promise<BillingUsageEvent[]>;
  findByApiId(apiId: string, from?: Date, to?: Date, limit?: number, offset?: number): Promise<BillingUsageEvent[]>;
  getTotalSpentByUser(userId: string, from?: Date, to?: Date): Promise<bigint>;
  getTotalRevenueByApi(apiId: string, from?: Date, to?: Date): Promise<bigint>;
  findUnindexedRevenueLedgerEvents(cursor?: string, limit?: number): Promise<RevenueLedgerUsageEvent[]>;
  indexRevenueLedgerEvent(event: RevenueLedgerUsageEvent, developerId: string): Promise<boolean>;
  findByUserIdCursor(params: {
    userId: string;
    from?: Date;
    to?: Date;
    limit: number;
    afterCursor?: CursorPayload;
    beforeCursor?: CursorPayload;
  }): Promise<{
    events: BillingUsageEvent[];
    nextCursor: string | null;
    prevCursor: string | null;
  }>;
}

export interface UsageEventsRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface UsageEventRow {
  id: string | number | bigint;
  user_id: string;
  api_id: string;
  endpoint_id: string;
  api_key_id: string;
  developer_id: string;
  amount_usdc: string | number | bigint;
  request_id: string;
  stellar_tx_hash: string | null;
  created_at: Date | string;
}

interface TotalRow {
  total: string | number | bigint | null;
  count?: string | number;
}

interface RevenueLedgerUsageEventRow {
  usage_event_id: string | number | bigint;
  api_id: string;
  amount_usdc: string | number | bigint;
  created_at: Date | string;
}

const assertNonEmpty = (value: string, fieldName: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }

  return trimmed;
};

const assertAmount = (amount: bigint): bigint => {
  if (amount < 0n) {
    throw new Error('amount must be greater than or equal to 0.');
  }

  return amount;
};

const assertValidRange = (from?: Date, to?: Date): void => {
  if (from && Number.isNaN(from.getTime())) {
    throw new Error('from must be a valid date.');
  }

  if (to && Number.isNaN(to.getTime())) {
    throw new Error('to must be a valid date.');
  }

  if (from && to && from > to) {
    throw new Error('from must be before or equal to to.');
  }
};

const normalizeLimit = (limit?: number): number | undefined => {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer.');
  }

  return limit;
};

const normalizeCursor = (cursor?: string): string | undefined => {
  if (cursor === undefined) {
    return undefined;
  }

  const trimmed = cursor.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('cursor must be a non-negative integer string.');
  }

  return trimmed;
};

const toBigInt = (value: string | number | bigint | null, fieldName: string): bigint => {
  if (value === null || value === undefined) {
    return 0n;
  }

  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`${fieldName} must be an integer value.`);
    }

    return BigInt(value);
  }

  const trimmed = value.trim();
  // Handle potential DECIMAL(20, 7) string format from PG (e.g. "100.0000000")
  const [integerPart, fractionalPart] = trimmed.split('.');
  
  if (fractionalPart && !/^[0]+$/.test(fractionalPart)) {
    throw new Error(`${fieldName} must be stored as an integer string in smallest units. Got: ${value}`);
  }

  if (!integerPart || !/^-?\d+$/.test(integerPart)) {
    throw new Error(`${fieldName} must be stored as an integer string in smallest units. Got: ${value}`);
  }

  return BigInt(integerPart);
};

const mapUsageEventRow = (row: UsageEventRow): BillingUsageEvent => ({
  id: String(row.id),
  userId: row.user_id,
  apiId: row.api_id,
  endpointId: row.endpoint_id,
  apiKeyId: row.api_key_id,
  developerId: row.developer_id,
  amount: toBigInt(row.amount_usdc, 'amount_usdc'),
  requestId: row.request_id,
  stellarTxHash: row.stellar_tx_hash,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
});

const mapRevenueLedgerUsageEventRow = (
  row: RevenueLedgerUsageEventRow,
): RevenueLedgerUsageEvent => ({
  usageEventId: String(row.usage_event_id),
  apiId: row.api_id,
  amount: toBigInt(row.amount_usdc, 'amount_usdc'),
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
});

const appendDateFilters = (params: unknown[], clauses: string[], from?: Date, to?: Date): void => {
  if (from) {
    params.push(from);
    clauses.push(`created_at >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    clauses.push(`created_at <= $${params.length}`);
  }
};

export class PgUsageEventsRepository implements UsageEventsPgRepository {
  private readonly readDb: UsageEventsRepositoryQueryable;
  private readonly writeDb: UsageEventsRepositoryQueryable;

  /**
   * @param db - Optional injectable queryable used in tests.
   *   When omitted the module-level routing helpers are used:
   *   - reads  → readQuery()  (replica-aware)
   *   - writes → writeQuery() (primary only)
   */
  constructor(db?: UsageEventsRepositoryQueryable) {
    if (db) {
      // In tests both read and write use the same injected queryable.
      this.readDb = db;
      this.writeDb = db;
    } else {
      // Production: route reads to replicas and writes to primary.
      this.readDb = { query: readQuery };
      this.writeDb = { query: writeQuery };
    }
  }

  async create(event: CreateUsageEventInput): Promise<BillingUsageEvent> {
    const userId = assertNonEmpty(event.userId, 'userId');
    const apiId = assertNonEmpty(event.apiId, 'apiId');
    const endpointId = assertNonEmpty(event.endpointId, 'endpointId');
    const apiKeyId = assertNonEmpty(event.apiKeyId, 'apiKeyId');
    const developerId = (event.developerId ?? '').trim();
    const requestId = assertNonEmpty(event.requestId, 'requestId');
    const amount = assertAmount(event.amount).toString();

    const result = await this.writeDb.query<UsageEventRow>(
      `
      INSERT INTO usage_events (
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
        developer_id,
        amount_usdc,
        request_id,
        stellar_tx_hash,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))
      ON CONFLICT (request_id, developer_id)
      DO UPDATE SET request_id = EXCLUDED.request_id
      RETURNING
        id,
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
        developer_id,
        amount_usdc,
        request_id,
        stellar_tx_hash,
        created_at
    `,
      [
        userId,
        apiId,
        endpointId,
        apiKeyId,
        developerId,
        amount,
        requestId,
        event.stellarTxHash ?? null,
        event.createdAt ?? null,
      ],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`Failed to create or retrieve usage event for requestId "${requestId}".`);
    }

    return mapUsageEventRow(row);
  }

  async findByUserId(
    userId: string,
    from?: Date,
    to?: Date,
    limit?: number,
    offset?: number,
  ): Promise<BillingUsageEvent[]> {
    return this.findByColumn('user_id', assertNonEmpty(userId, 'userId'), from, to, limit, offset);
  }

  async findByUser(query: UserUsageEventQuery): Promise<UsageEvent[]> {
    // Check if cursor pagination is requested
    if (query.cursor) {
      return this.findByUserWithCursor(query);
    }

    const events = await this.findByColumn(
      'user_id',
      assertNonEmpty(query.userId, 'userId'),
      query.from,
      query.to,
      query.limit,
      query.offset,
      query.apiId
    );
    return events.map(event => ({
      id: event.id,
      developerId: event.userId, // mapped
      apiId: event.apiId,
      endpoint: event.endpointId,
      userId: event.userId,
      occurredAt: event.createdAt,
      revenue: event.amount,
    }));
  }

  /**
   * Cursor-based pagination for findByUser using keyset pagination
   * Uses (created_at, id) index for O(log n) performance on deep pages
   */
  private async findByUserWithCursor(query: UserUsageEventQuery): Promise<UsageEvent[]> {
    const userId = assertNonEmpty(query.userId, 'userId');
    assertValidRange(query.from, query.to);
    
    // Decode cursor if provided
    let cursorCondition = '';
    const params: unknown[] = [userId];
    let paramIndex = 2;
    
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      // Keyset condition: (created_at, id) < (cursor.created_at, cursor.id)
      cursorCondition = ` AND (created_at, id) < ($${paramIndex}, $${paramIndex + 1})`;
      params.push(decoded.created_at, decoded.id);
      paramIndex += 2;
    }

    const normalizedLimit = normalizeLimit(query.limit) ?? 20;
    // Fetch one extra to check for more
    const fetchLimit = normalizedLimit + 1;

    const clauses: string[] = [`user_id = $1`];
    appendDateFilters(params, clauses, query.from, query.to);

    if (query.apiId) {
      params.push(query.apiId);
      clauses.push(`api_id = $${params.length}`);
    }

    const sql = `
      SELECT
        id,
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
        developer_id,
        amount_usdc,
        request_id,
        stellar_tx_hash,
        created_at
      FROM usage_events
      WHERE ${clauses.join(' AND ')}
      ${cursorCondition}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1}
    `;
    params.push(fetchLimit);

    const result = await this.db.query<UsageEventRow>(sql, params);
    const rows = result.rows;

    // Check if there are more results
    const hasMore = rows.length > normalizedLimit;
    const items = hasMore ? rows.slice(0, normalizedLimit) : rows;

    // Generate next cursor if there are more
    let nextCursor: string | undefined;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = generateCursor(
        lastItem.created_at instanceof Date ? lastItem.created_at.toISOString() : lastItem.created_at,
        String(lastItem.id)
      );
    }

    // Return mapped events with cursor info
    const events = items.map(event => ({
      id: String(event.id),
      developerId: event.user_id,
      apiId: event.api_id,
      endpoint: event.endpoint_id,
      userId: event.user_id,
      occurredAt: event.created_at instanceof Date ? event.created_at : new Date(event.created_at),
      revenue: toBigInt(event.amount_usdc, 'amount_usdc'),
      // Attach cursor info for response
      _cursor: nextCursor,
    }));

    // Store cursor info for route to use
    (events as any)._nextCursor = nextCursor;
    (events as any)._hasMore = hasMore;

    return events;
  }

  async findByApiId(
    apiId: string,
    from?: Date,
    to?: Date,
    limit?: number,
    offset?: number,
  ): Promise<BillingUsageEvent[]> {
    return this.findByColumn('api_id', assertNonEmpty(apiId, 'apiId'), from, to, limit, offset);
  }

  async findByDeveloper(query: UsageEventQuery): Promise<UsageEvent[]> {
    const events = await this.findByColumn(
      'user_id', // Assuming developer owns these events as userId
      assertNonEmpty(query.developerId, 'developerId'),
      query.from,
      query.to,
      undefined,
      undefined,
      query.apiId
    );
    return events.map(event => ({
      id: event.id,
      developerId: event.userId,
      apiId: event.apiId,
      endpoint: event.endpointId,
      userId: event.userId,
      occurredAt: event.createdAt,
      revenue: event.amount,
    }));
  }

  async getTotalSpentByUser(userId: string, from?: Date, to?: Date): Promise<bigint> {
    return this.sumByColumn('user_id', assertNonEmpty(userId, 'userId'), from, to);
  }

  async getTotalRevenueByApi(apiId: string, from?: Date, to?: Date): Promise<bigint> {
    return this.sumByColumn('api_id', assertNonEmpty(apiId, 'apiId'), from, to);
  }

  async findUnindexedRevenueLedgerEvents(
    cursor?: string,
    limit = 100,
  ): Promise<RevenueLedgerUsageEvent[]> {
    const normalizedCursor = normalizeCursor(cursor) ?? '0';
    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit === 0) {
      return [];
    }

    const result = await this.readDb.query<RevenueLedgerUsageEventRow>(
      `
        SELECT
          ue.id AS usage_event_id,
          ue.api_id,
          ue.amount_usdc,
          ue.created_at
        FROM usage_events ue
        LEFT JOIN revenue_ledger rl
          ON rl.usage_event_id = ue.id
        WHERE ue.id > $1
          AND rl.usage_event_id IS NULL
        ORDER BY ue.id ASC
        LIMIT $2
      `,
      [normalizedCursor, normalizedLimit],
    );

    return result.rows.map(mapRevenueLedgerUsageEventRow);
  }

  async indexRevenueLedgerEvent(event: RevenueLedgerUsageEvent, developerId: string): Promise<boolean> {
    const result = await this.writeDb.query<{ inserted: number }>(
      `
        INSERT INTO revenue_ledger (
          api_id,
          developer_id,
          amount_usdc,
          usage_event_id,
          created_at
        )
        SELECT $1, $2, $3::numeric, $4::bigint, $5::timestamp
        WHERE NOT EXISTS (
          SELECT 1
          FROM revenue_ledger
          WHERE usage_event_id = $4::bigint
        )
        ON CONFLICT (usage_event_id) DO NOTHING
        RETURNING 1 AS inserted
      `,
      [
        assertNonEmpty(event.apiId, 'apiId'),
        assertNonEmpty(developerId, 'developerId'),
        assertAmount(event.amount).toString(),
        normalizeCursor(event.usageEventId) ?? '0',
        event.createdAt,
      ],
    );

    return Boolean(result.rows[0]);
  }

  async findByUserIdCursor(params: {
    userId: string;
    from?: Date;
    to?: Date;
    limit: number;
    afterCursor?: CursorPayload;
    beforeCursor?: CursorPayload;
  }): Promise<{
    events: BillingUsageEvent[];
    nextCursor: string | null;
    prevCursor: string | null;
  }> {
    const { userId, from, to, limit, afterCursor, beforeCursor } = params;

    assertValidRange(from, to);

    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit === undefined || normalizedLimit === 0) {
      return { events: [], nextCursor: null, prevCursor: null };
    }

    // We fetch limit+1 to detect whether another page exists beyond this one.
    const fetchLimit = normalizedLimit + 1;

    // When paging backward we reverse the ORDER BY, collect the results, then
    // flip them so the caller always receives items in ascending order.
    const isBackward = beforeCursor !== undefined && afterCursor === undefined;
    const order = isBackward ? 'DESC' : 'ASC';

    const sqlParams: unknown[] = [assertNonEmpty(userId, 'userId')];
    const whereClauses: string[] = ['user_id = $1'];

    if (from) {
      sqlParams.push(from);
      whereClauses.push(`created_at >= $${sqlParams.length}`);
    }

    if (to) {
      sqlParams.push(to);
      whereClauses.push(`created_at <= $${sqlParams.length}`);
    }

    if (afterCursor) {
      // Rows strictly after the cursor (forward pagination).
      // Expanded form of: (created_at, id) > (cursor.ts, cursor.id)
      // pg-mem does not support row-value comparisons so we expand manually.
      sqlParams.push(afterCursor.timestamp);
      sqlParams.push(BigInt(afterCursor.id));
      const tsIdx = sqlParams.length - 1;
      const idIdx = sqlParams.length;
      whereClauses.push(
        `(created_at > $${tsIdx} OR (created_at = $${tsIdx} AND id > $${idIdx}))`,
      );
    } else if (beforeCursor) {
      // Rows strictly before the cursor (backward pagination).
      // Expanded form of: (created_at, id) < (cursor.ts, cursor.id)
      sqlParams.push(beforeCursor.timestamp);
      sqlParams.push(BigInt(beforeCursor.id));
      const tsIdx = sqlParams.length - 1;
      const idIdx = sqlParams.length;
      whereClauses.push(
        `(created_at < $${tsIdx} OR (created_at = $${tsIdx} AND id < $${idIdx}))`,
      );
    }

    sqlParams.push(fetchLimit);
    const limitClause = `LIMIT $${sqlParams.length}`;

    const sql = `
      SELECT
        id,
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
        developer_id,
        amount_usdc,
        request_id,
        stellar_tx_hash,
        created_at
      FROM usage_events
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at ${order}, id ${order}
      ${limitClause}
    `;

    const result = await this.db.query<UsageEventRow>(sql, sqlParams);
    const rows = result.rows.map(mapUsageEventRow);

    // Determine whether there is a page beyond what we're returning
    const hasMore = rows.length > normalizedLimit;
    const pageRows = hasMore ? rows.slice(0, normalizedLimit) : rows;

    // When fetching backward the DB returns items in reverse order — flip them.
    if (isBackward) {
      pageRows.reverse();
    }

    // Build cursors from the boundary items of this page.
    const firstItem = pageRows[0];
    const lastItem = pageRows[pageRows.length - 1];

    // nextCursor: there are items after the last item on this page
    const nextCursor =
      lastItem !== undefined && ((!isBackward && hasMore) || isBackward)
        ? encodeCursor(lastItem.createdAt, lastItem.id)
        : null;

    // prevCursor: there are items before the first item on this page
    const prevCursor =
      firstItem !== undefined && ((isBackward && hasMore) || afterCursor !== undefined)
        ? encodeCursor(firstItem.createdAt, firstItem.id)
        : null;

    return { events: pageRows, nextCursor, prevCursor };
  }

  private async findByColumn(
    column: 'user_id' | 'api_id',
    value: string,
    from?: Date,
    to?: Date,
    limit?: number,
    offset?: number,
    apiId?: string,
  ): Promise<BillingUsageEvent[]> {
    assertValidRange(from, to);
    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit === 0) {
      return [];
    }


    const params: unknown[] = [value];
    const clauses = [`${column} = $1`];
    appendDateFilters(params, clauses, from, to);

    if (apiId) {
      params.push(apiId);
      clauses.push(`api_id = $${params.length}`);
    }

    let sql = `
      SELECT
        id,
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
        developer_id,
        amount_usdc,
        request_id,
        stellar_tx_hash,
        created_at
      FROM usage_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
    `;

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
      sql += ` LIMIT $${params.length}`;
    }

    if (offset !== undefined && offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await this.readDb.query<UsageEventRow>(sql, params);
    return result.rows.map(mapUsageEventRow);
  }

  private async sumByColumn(
    column: 'user_id' | 'api_id',
    value: string,
    from?: Date,
    to?: Date,
  ): Promise<bigint> {
    assertValidRange(from, to);

    const params: unknown[] = [value];
    const clauses = [`${column} = $1`];
    appendDateFilters(params, clauses, from, to);

    const result = await this.readDb.query<TotalRow>(
      `
        SELECT COALESCE(SUM(amount_usdc), 0)::text AS total
        FROM usage_events
        WHERE ${clauses.join(' AND ')}
      `,
      params,
    );

    return toBigInt(result.rows[0]?.total ?? '0', 'total');
  }

  async getTopEndpoints(query: {
    userId: string;
    from: Date;
    to: Date;
    apiId?: string;
    limit: number;
  }): Promise<Array<{ endpoint: string; calls: number; revenue: bigint }>> {
    assertValidRange(query.from, query.to);
    const normalizedLimit = normalizeLimit(query.limit) ?? 5;

    const params: unknown[] = [assertNonEmpty(query.userId, 'userId')];
    const clauses = ['user_id = $1'];
    appendDateFilters(params, clauses, query.from, query.to);

    if (query.apiId) {
      params.push(query.apiId);
      clauses.push(`api_id = $${params.length}`);
    }

    params.push(normalizedLimit);
    const sql = `
      SELECT
        endpoint_id AS endpoint,
        COUNT(*)::int AS calls,
        COALESCE(SUM(amount_usdc), 0)::text AS revenue
      FROM usage_events
      WHERE ${clauses.join(' AND ')}
      GROUP BY endpoint_id
      ORDER BY calls DESC, endpoint_id ASC
      LIMIT $${params.length}
    `;

    const result = await this.readDb.query<{ endpoint: string; calls: number; revenue: string }>(sql, params);
    return result.rows.map((row) => ({
      endpoint: row.endpoint,
      calls: row.calls,
      revenue: toBigInt(row.revenue, 'revenue'),
    }));
  }
} 
