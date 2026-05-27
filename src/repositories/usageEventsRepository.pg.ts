import {
  type UsageEventsRepository,
  type UsageEvent,
  type UsageEventQuery,
  type UserUsageEventQuery,
  type UsageStats,
  type UsageBucket,
  type GroupBy,
} from './usageEventsRepository.js';

export interface CreateUsageEventInput {
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
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
  amount: bigint;
  requestId: string;
  stellarTxHash: string | null;
  createdAt: Date;
}

export interface UsageEventsPgRepository extends UsageEventsRepository {
  create(event: CreateUsageEventInput): Promise<BillingUsageEvent>;
  findByUserId(userId: string, from?: Date, to?: Date, limit?: number, offset?: number): Promise<BillingUsageEvent[]>;
  findByApiId(apiId: string, from?: Date, to?: Date, limit?: number, offset?: number): Promise<BillingUsageEvent[]>;
  getTotalSpentByUser(userId: string, from?: Date, to?: Date): Promise<bigint>;
  getTotalRevenueByApi(apiId: string, from?: Date, to?: Date): Promise<bigint>;
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
  amount_usdc: string | number | bigint;
  request_id: string;
  stellar_tx_hash: string | null;
  created_at: Date | string;
}

interface TotalRow {
  total: string | number | bigint | null;
  count?: string | number;
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
  amount: toBigInt(row.amount_usdc, 'amount_usdc'),
  requestId: row.request_id,
  stellarTxHash: row.stellar_tx_hash,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
});

const mapToUsageEvent = (row: UsageEventRow): UsageEvent => ({
  id: String(row.id),
  developerId: row.user_id, // For now assuming user_id maps to developerId in this context
  apiId: row.api_id,
  endpoint: row.endpoint_id,
  userId: row.user_id,
  occurredAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  revenue: toBigInt(row.amount_usdc, 'amount_usdc'),
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
  constructor(private readonly db: UsageEventsRepositoryQueryable) { }

  async create(event: CreateUsageEventInput): Promise<BillingUsageEvent> {
    const userId = assertNonEmpty(event.userId, 'userId');
    const apiId = assertNonEmpty(event.apiId, 'apiId');
    const endpointId = assertNonEmpty(event.endpointId, 'endpointId');
    const apiKeyId = assertNonEmpty(event.apiKeyId, 'apiKeyId');
    const requestId = assertNonEmpty(event.requestId, 'requestId');
    const amount = assertAmount(event.amount).toString();

    const result = await this.db.query<UsageEventRow>(
      `
      INSERT INTO usage_events (
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
        amount_usdc,
        request_id,
        stellar_tx_hash,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
      ON CONFLICT (request_id)
      DO UPDATE SET request_id = EXCLUDED.request_id
      RETURNING
        id,
        user_id,
        api_id,
        endpoint_id,
        api_key_id,
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

  async developerOwnsApi(developerId: string, apiId: string): Promise<boolean> {
    // This is a simplified check: does the developer have any events for this API?
    // In a real system, this should check the apis table.
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM usage_events WHERE user_id = $1 AND api_id = $2 LIMIT 1`,
      [developerId, apiId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  }

  async aggregateByDeveloper(developerId: string): Promise<UsageStats[]> {
    const result = await this.db.query<{ api_id: string; calls: string; revenue: string }>(
      `
        SELECT
          api_id,
          COUNT(*)::text AS calls,
          SUM(amount_usdc)::text AS revenue
        FROM usage_events
        WHERE user_id = $1
        GROUP BY api_id
      `,
      [developerId]
    );

    return result.rows.map(row => ({
      apiId: row.api_id,
      calls: parseInt(row.calls, 10),
      revenue: toBigInt(row.revenue, 'revenue'),
    }));
  }

  async aggregateByUser(query: UserUsageEventQuery): Promise<{
    totalRevenue: bigint;
    totalCalls: number;
    breakdownByApi: UsageStats[];
    buckets?: UsageBucket[];
  }> {
    assertValidRange(query.from, query.to);
    const userId = assertNonEmpty(query.userId, 'userId');

    const params: unknown[] = [userId];
    const clauses = [`user_id = $1`];
    appendDateFilters(params, clauses, query.from, query.to);

    if (query.apiId) {
      params.push(query.apiId);
      clauses.push(`api_id = $${params.length}`);
    }

    const whereClause = clauses.join(' AND ');

    // 1. Get totals
    const totalResult = await this.db.query<{ total: string | null; count: string }>(
      `
        SELECT
          COALESCE(SUM(amount_usdc), 0)::text AS total,
          COUNT(*)::text AS count
        FROM usage_events
        WHERE ${whereClause}
      `,
      params,
    );

    const totalRevenue = toBigInt(totalResult.rows[0]?.total ?? '0', 'total');
    const totalCalls = parseInt(totalResult.rows[0]?.count ?? '0', 10);

    // 2. Get breakdown by API
    const breakdownResult = await this.db.query<{ api_id: string; calls: string; revenue: string }>(
      `
        SELECT
          api_id,
          COUNT(*)::text AS calls,
          SUM(amount_usdc)::text AS revenue
        FROM usage_events
        WHERE ${whereClause}
        GROUP BY api_id
      `,
      params,
    );

    const breakdownByApi = breakdownResult.rows.map(row => ({
      apiId: row.api_id,
      calls: parseInt(row.calls, 10),
      revenue: toBigInt(row.revenue, 'revenue'),
    }));

    // 3. Optional bucketing
    let buckets: UsageBucket[] | undefined;
    if (query.groupBy) {
      const bucketResult = await this.db.query<{ period: string | Date; calls: string; revenue: string }>(
        `
          SELECT
            date_trunc($${params.length + 1}, created_at) AS period,
            COUNT(*)::text AS calls,
            SUM(amount_usdc)::text AS revenue
          FROM usage_events
          WHERE ${whereClause}
          GROUP BY period
          ORDER BY period ASC
        `,
        [...params, query.groupBy],
      );

      buckets = bucketResult.rows.map(row => ({
        period: new Date(row.period).toISOString().slice(0, 10),
        calls: parseInt(row.calls, 10),
        revenue: toBigInt(row.revenue, 'revenue'),
      }));
    }

    return {
      totalRevenue,
      totalCalls,
      breakdownByApi,
      buckets,
    };
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

    const result = await this.db.query<UsageEventRow>(sql, params);
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

    const result = await this.db.query<TotalRow>(
      `
        SELECT COALESCE(SUM(amount_usdc), 0)::text AS total
        FROM usage_events
        WHERE ${clauses.join(' AND ')}
      `,
      params,
    );

    return toBigInt(result.rows[0]?.total ?? '0', 'total');
  }
}
