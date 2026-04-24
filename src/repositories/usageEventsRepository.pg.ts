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

export interface UsageEventsPgRepository {
  create(event: CreateUsageEventInput): Promise<BillingUsageEvent>;
  findByUserId(userId: string, from?: Date, to?: Date, limit?: number): Promise<BillingUsageEvent[]>;
  findByApiId(apiId: string, from?: Date, to?: Date, limit?: number): Promise<BillingUsageEvent[]>;
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
  if (value === null) {
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
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be stored as an integer string in smallest units.`);
  }

  return BigInt(trimmed);
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
  constructor(private readonly db: UsageEventsRepositoryQueryable) {}

  async create(event: CreateUsageEventInput): Promise<BillingUsageEvent> {
    const userId = assertNonEmpty(event.userId, 'userId');
    const apiId = assertNonEmpty(event.apiId, 'apiId');
    const endpointId = assertNonEmpty(event.endpointId, 'endpointId');
    const apiKeyId = assertNonEmpty(event.apiKeyId, 'apiKeyId');
    const requestId = assertNonEmpty(event.requestId, 'requestId');
    const amount = assertAmount(event.amount).toString();

    await this.db.query(
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
        ON CONFLICT (request_id) DO NOTHING
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

    const existing = await this.db.query<UsageEventRow>(
      `
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
        WHERE request_id = $1
        LIMIT 1
      `,
      [requestId],
    );

    if (!existing.rows[0]) {
      throw new Error(`Usage event with requestId "${requestId}" could not be loaded after insert.`);
    }

    return mapUsageEventRow(existing.rows[0]);
  }

  async findByUserId(
    userId: string,
    from?: Date,
    to?: Date,
    limit?: number,
  ): Promise<BillingUsageEvent[]> {
    return this.findByColumn('user_id', assertNonEmpty(userId, 'userId'), from, to, limit);
  }

  async findByApiId(
    apiId: string,
    from?: Date,
    to?: Date,
    limit?: number,
  ): Promise<BillingUsageEvent[]> {
    return this.findByColumn('api_id', assertNonEmpty(apiId, 'apiId'), from, to, limit);
  }

  async getTotalSpentByUser(userId: string, from?: Date, to?: Date): Promise<bigint> {
    return this.sumByColumn('user_id', assertNonEmpty(userId, 'userId'), from, to);
  }

  async getTotalRevenueByApi(apiId: string, from?: Date, to?: Date): Promise<bigint> {
    return this.sumByColumn('api_id', assertNonEmpty(apiId, 'apiId'), from, to);
  }

  private async findByColumn(
    column: 'user_id' | 'api_id',
    value: string,
    from?: Date,
    to?: Date,
    limit?: number,
  ): Promise<BillingUsageEvent[]> {
    assertValidRange(from, to);
    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit === 0) {
      return [];
    }

    const params: unknown[] = [value];
    const clauses = [`${column} = $1`];
    appendDateFilters(params, clauses, from, to);

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
        SELECT COALESCE(SUM(amount_usdc), 0) AS total
        FROM usage_events
        WHERE ${clauses.join(' AND ')}
      `,
      params,
    );

    return toBigInt(result.rows[0]?.total ?? 0, 'total');
  }
}
