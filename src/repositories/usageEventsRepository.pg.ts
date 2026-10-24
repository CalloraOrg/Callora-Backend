import {
  type UsageEvent,
  type UsageEventQuery,
  type UserUsageEventQuery,
  type ConsumerChargeRow,
  type ListChargesResult,
} from './usageEventsRepository.js';
import { encodeCursor, type CursorPayload } from '../lib/cursorPagination.js';
import { generateCursor, decodeCursor } from '../lib/pagination.js';
import { pool, readQuery, writeQuery } from '../db.js';

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
  amount: bigint | string | number;
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
  stellarTxHash?: string | null;
  deductionStatus?: 'pending' | 'confirmed' | 'voided' | null;
}

export interface UsageEventsPgRepository {
  getEventsInRange(from: Date, to: Date, options: UsageEventsRangeOptions): Promise<BillingUsageEvent[]>;
  create(event: CreateUsageEventInput): Promise<BillingUsageEvent>;
  countByDeveloper(query: { developerId: string; from: Date; to: Date }): Promise<number>;
  findByUserId(userId: string, from?: Date, to?: Date, limit?: number, offset?: number): Promise<BillingUsageEvent[]>;
  findByApiId(apiId: string, from?: Date, to?: Date, limit?: number, offset?: number): Promise<BillingUsageEvent[]>;
  getTotalSpentByUser(userId: string, from?: Date, to?: Date): Promise<bigint>;
  getTotalRevenueByApi(apiId: string, from?: Date, to?: Date): Promise<bigint>;
  findUnindexedRevenueLedgerEvents(cursor?: string, limit?: number): Promise<RevenueLedgerUsageEvent[]>;
  indexRevenueLedgerEvent(event: RevenueLedgerUsageEvent, developerId: string): Promise<boolean>;
  getRevenueLedgerCheckpoint(): Promise<string>;
  advanceRevenueLedgerCheckpoint(id: string): Promise<void>;
  recordRevenueLedgerSkip(id: string, reason: string, maxAttempts: number): Promise<{ attempts: number; permanent: boolean }>;
  clearRevenueLedgerSkip(id: string): Promise<void>;
  reverseVoidedRevenueLedgerEvents(): Promise<number>;
  acquireRevenueLedgerIndexerLock(): Promise<boolean>;
  releaseRevenueLedgerIndexerLock(): Promise<void>;
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
  sumSpendByConsumer(query: {
    userId: string;
    from: Date;
    to: Date;
  }): Promise<{ totalUnits: bigint; calls: number }>;
  /**
   * Returns paginated billing-history rows for the consumer identified by
   * `userId`, ordered by (created_at DESC, id DESC) for stable keyset
   * pagination.  Fetches `limit + 1` rows to detect next-page existence.
   *
   * Uses idx_usage_events_user_created for the scan; the (id DESC) tiebreak
   * within the same timestamp keeps ordering deterministic.
   */
  listChargesByConsumer(params: {
    userId: string;
    limit: number;
    cursor?: CursorPayload;
  }): Promise<ListChargesResult>;
}

export interface UsageEventsRangeOptions {
  developerId?: string;
  cursor?: string;
  limit: number;
}

export interface UsageEventsRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  connect?: () => Promise<{
    query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    release(): void;
  }>;
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
  stellar_tx_hash?: string | null;
  deduction_status?: 'pending' | 'confirmed' | 'voided' | null;
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

export class CorruptUsageAmountError extends Error {
  public readonly rowId?: string;
  public readonly fieldName: string;
  public readonly rawValue: unknown;

  constructor(
    message: string,
    options?: { rowId?: string; fieldName?: string; rawValue?: unknown },
  ) {
    super(message);
    this.name = 'CorruptUsageAmountError';
    this.rowId = options?.rowId;
    this.fieldName = options?.fieldName ?? 'amount_usdc';
    this.rawValue = options?.rawValue;
    Object.setPrototypeOf(this, CorruptUsageAmountError.prototype);
  }
}

export const CorruptAmountError = CorruptUsageAmountError;
export type CorruptAmountError = CorruptUsageAmountError;

export const toBigInt = (
  value: string | number | bigint | null,
  fieldName: string,
  rowId?: string,
): bigint => {
  if (value === null || value === undefined) {
    return 0n;
  }

  if (typeof value === 'bigint') {
    return value;
  }

  const rowContext = rowId ? ` (row: ${rowId})` : '';

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new CorruptUsageAmountError(
        `${fieldName} must be an integer value.${rowContext}`,
        { rowId, fieldName, rawValue: value },
      );
    }

    return BigInt(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new CorruptUsageAmountError(
        `${fieldName} must be stored as an integer string in smallest units. Got: ${value}${rowContext}`,
        { rowId, fieldName, rawValue: value },
      );
    }

    return BigInt(trimmed);
  }

  throw new CorruptUsageAmountError(
    `${fieldName} must be stored as an integer string in smallest units. Got: ${String(value)}${rowContext}`,
    { rowId, fieldName, rawValue: value },
  );
};

const mapUsageEventRow = (row: UsageEventRow): BillingUsageEvent => ({
  id: String(row.id),
  userId: row.user_id,
  apiId: row.api_id,
  endpointId: row.endpoint_id,
  apiKeyId: row.api_key_id,
  developerId: row.developer_id,
  amount: toBigInt(row.amount_usdc, 'amount_usdc', String(row.id)),
  requestId: row.request_id,
  stellarTxHash: row.stellar_tx_hash,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
});

const mapRevenueLedgerUsageEventRow = (
  row: RevenueLedgerUsageEventRow,
): RevenueLedgerUsageEvent => ({
  usageEventId: String(row.usage_event_id),
  apiId: row.api_id,
  amount: toBigInt(row.amount_usdc, 'amount_usdc', String(row.usage_event_id)),
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  stellarTxHash: row.stellar_tx_hash,
  deductionStatus: row.deduction_status,
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
  private advisoryLockClient: Awaited<ReturnType<NonNullable<UsageEventsRepositoryQueryable['connect']>>> | undefined;

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
      // Production: route reads to replicas and writes, including session locks, to the primary.
      this.readDb = { query: readQuery };
      this.writeDb = { query: writeQuery, connect: () => pool.connect() };
    }
  }

  /** Read a bounded page of events from a half-open time range. */
  async getEventsInRange(
    from: Date,
    to: Date,
    options: UsageEventsRangeOptions,
  ): Promise<BillingUsageEvent[]> {
    assertValidRange(from, to);
    const limit = normalizeLimit(options.limit);
    if (limit === undefined || limit === 0) return [];

    const params: unknown[] = [from, to];
    const clauses = ['created_at >= $1', 'created_at < $2'];
    if (options.developerId !== undefined) {
      params.push(assertNonEmpty(options.developerId, 'developerId'));
      clauses.push(`developer_id = $${params.length}`);
    }
    if (options.cursor !== undefined) {
      const cursor = normalizeCursor(options.cursor);
      params.push(BigInt(cursor ?? '0'));
      clauses.push(`id > $${params.length}`);
    }
    params.push(limit);
    const result = await this.readDb.query<UsageEventRow>(
      `SELECT id, user_id, api_id, endpoint_id, api_key_id, developer_id,
              amount_usdc, request_id, stellar_tx_hash, created_at
       FROM usage_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY id ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapUsageEventRow);
  }

  async create(event: CreateUsageEventInput): Promise<BillingUsageEvent> {
    const userId = assertNonEmpty(event.userId, 'userId');
    const apiId = assertNonEmpty(event.apiId, 'apiId');
    const endpointId = assertNonEmpty(event.endpointId, 'endpointId');
    const apiKeyId = assertNonEmpty(event.apiKeyId, 'apiKeyId');
    const requestId = assertNonEmpty(event.requestId, 'requestId');
    const amountVal = typeof event.amount === 'bigint'
      ? assertAmount(event.amount)
      : assertAmount(toBigInt(event.amount, 'amount'));
    const amount = amountVal.toString();

    const result = await this.writeDb.query<UsageEventRow>(
      `
      WITH owner AS (
        SELECT developer_id::text AS developer_id FROM apis WHERE id::text = $2 LIMIT 1
      ), reservation AS (
        INSERT INTO usage_event_request_ids (request_id, usage_event_id, developer_id)
        SELECT $6, nextval(pg_get_serial_sequence('usage_events', 'id')), developer_id FROM owner
        ON CONFLICT (request_id) DO NOTHING
        RETURNING usage_event_id, developer_id
      ), inserted AS (
        INSERT INTO usage_events (
          id, user_id, api_id, endpoint_id, api_key_id, developer_id,
          amount_usdc, request_id, stellar_tx_hash, created_at
        )
        SELECT r.usage_event_id, $1, $2, $3, $4, r.developer_id,
               $5, $6, $7, COALESCE($8, NOW())
        FROM reservation r
        RETURNING id, user_id, api_id, endpoint_id, api_key_id, developer_id,
                  amount_usdc, request_id, stellar_tx_hash, created_at
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT ue.id, ue.user_id, ue.api_id, ue.endpoint_id, ue.api_key_id,
             ue.developer_id, ue.amount_usdc, ue.request_id, ue.stellar_tx_hash, ue.created_at
      FROM usage_event_request_ids r
      JOIN usage_events ue ON ue.id = r.usage_event_id
      WHERE r.request_id = $6 AND NOT EXISTS (SELECT 1 FROM inserted)
    `,
      [
        userId, apiId, endpointId, apiKeyId, amount, requestId,
        event.stellarTxHash ?? null, event.createdAt ?? null,
      ],
    );

    const row = result.rows[0];

    if (!row) {
      const api = await this.writeDb.query('SELECT 1 FROM apis WHERE id::text = $1 LIMIT 1', [apiId]);
      if (!api.rows[0]) {
        throw Object.assign(new Error(`Unknown API: ${apiId}`), { statusCode: 404, code: 'API_NOT_FOUND' });
      }
      // A concurrent writer may have committed the reservation after this
      // statement's snapshot was taken. A fresh statement sees its complete row.
      const retry = await this.writeDb.query<UsageEventRow>(
        `SELECT ue.id, ue.user_id, ue.api_id, ue.endpoint_id, ue.api_key_id,
                ue.developer_id, ue.amount_usdc, ue.request_id, ue.stellar_tx_hash, ue.created_at
           FROM usage_event_request_ids r JOIN usage_events ue ON ue.id = r.usage_event_id
          WHERE r.request_id = $1`, [requestId],
      );
      if (!retry.rows[0]) throw new Error(`Reserved request id has no usage event: ${requestId}`);
      return mapUsageEventRow(retry.rows[0]);
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

    const result = await this.readDb.query<UsageEventRow>(sql, params);
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
      revenue: toBigInt(event.amount_usdc, 'amount_usdc', String(event.id)),
      // Attach cursor info for response
      _cursor: nextCursor,
    }));

    // Store cursor info for route to use
    Object.assign(events, { _nextCursor: nextCursor, _hasMore: hasMore });

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

  async countByDeveloper(query: { developerId: string; from: Date; to: Date }): Promise<number> {
    const developerId = assertNonEmpty(query.developerId, 'developerId');
    assertValidRange(query.from, query.to);
    const result = await this.readDb.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count
       FROM usage_events
       WHERE developer_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [developerId, query.from, query.to],
    );
    return Number(result.rows[0]?.count ?? 0);
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

    // The indexer is accounting work: always read from the primary.  Inspect
    // the catalog first so this remains compatible with deployments that have
    // not yet applied the deduction_status migration.
    const statusColumn = await this.writeDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_events' AND column_name = 'deduction_status' LIMIT 1`,
    );
    const statusSelect = statusColumn.rows.length ? 'ue.deduction_status' : 'NULL::text';
    const statusPredicate = statusColumn.rows.length
      ? `(ue.deduction_status = 'confirmed' OR ue.deduction_status = 'pending' OR ue.deduction_status = 'voided')`
      : 'TRUE';
    const result = await this.writeDb.query<RevenueLedgerUsageEventRow>(
      `
        SELECT
          ue.id AS usage_event_id,
          ue.api_id,
          ue.amount_usdc,
          ue.created_at,
          ue.stellar_tx_hash,
          ${statusSelect} AS deduction_status
        FROM usage_events ue
        LEFT JOIN revenue_ledger rl
          ON rl.usage_event_id = ue.id
        LEFT JOIN revenue_ledger_skips rs ON rs.usage_event_id = ue.id
        WHERE (ue.id > $1 OR (rs.usage_event_id IS NOT NULL AND rs.permanent = FALSE AND rs.next_retry_at <= NOW()))
          AND rl.usage_event_id IS NULL
          AND ${statusPredicate}
          AND (rs.usage_event_id IS NULL OR rs.permanent = FALSE AND rs.next_retry_at <= NOW())
        ORDER BY ue.id ASC
        LIMIT $2
      `,
      [normalizedCursor, normalizedLimit],
    );

    return result.rows.map(mapRevenueLedgerUsageEventRow);
  }

  async getRevenueLedgerCheckpoint(): Promise<string> {
    const result = await this.writeDb.query<{ last_usage_event_id: string | number | bigint }>(
      `SELECT last_usage_event_id FROM indexer_checkpoints WHERE name = 'revenue_ledger'`,
    );
    return String(result.rows[0]?.last_usage_event_id ?? '0');
  }

  async advanceRevenueLedgerCheckpoint(id: string): Promise<void> {
    await this.writeDb.query(
      `INSERT INTO indexer_checkpoints (name, last_usage_event_id, updated_at)
       VALUES ('revenue_ledger', $1::bigint, NOW())
       ON CONFLICT (name) DO UPDATE SET
         last_usage_event_id = GREATEST(indexer_checkpoints.last_usage_event_id, EXCLUDED.last_usage_event_id),
         updated_at = NOW(),
         locked_until = GREATEST(COALESCE(indexer_checkpoints.locked_until, NOW()), NOW() + INTERVAL '15 minutes')`, [id],
    );
  }

  async recordRevenueLedgerSkip(id: string, reason: string, maxAttempts: number): Promise<{ attempts: number; permanent: boolean }> {
    const result = await this.writeDb.query<{ attempts: number; permanent: boolean }>(
      `INSERT INTO revenue_ledger_skips (usage_event_id, reason, first_seen_at, attempts, next_retry_at, permanent)
       VALUES ($1::bigint, $2, NOW(), 1, NOW() + INTERVAL '30 seconds', FALSE)
       ON CONFLICT (usage_event_id) DO UPDATE SET
         reason = EXCLUDED.reason,
         attempts = revenue_ledger_skips.attempts + 1,
         next_retry_at = NOW() + (LEAST(3600, 30 * POWER(2, LEAST(revenue_ledger_skips.attempts - 1, 7))) * INTERVAL '1 second'),
         permanent = CASE WHEN EXCLUDED.reason = 'pending' THEN FALSE ELSE revenue_ledger_skips.attempts + 1 >= $3 END
       RETURNING attempts, permanent`, [id, reason, maxAttempts],
    );
    return result.rows[0] ?? { attempts: 1, permanent: false };
  }

  async clearRevenueLedgerSkip(id: string): Promise<void> {
    await this.writeDb.query(`DELETE FROM revenue_ledger_skips WHERE usage_event_id = $1::bigint`, [id]);
  }

  async reverseVoidedRevenueLedgerEvents(): Promise<number> {
    const statusColumn = await this.writeDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_events' AND column_name = 'deduction_status' LIMIT 1`,
    );
    if (statusColumn.rows.length === 0) return 0;
    const client = this.writeDb.connect ? await this.writeDb.connect() : undefined;
    const queryable = client ?? this.writeDb;
    let count = 0;
    try {
      if (client) await client.query('BEGIN');
      const voided = await queryable.query<{
        id: string | number;
        usage_event_id: string | number;
        settlement_id: string | number | null;
      }>(
        `SELECT rl.id, rl.usage_event_id, rl.settlement_id
         FROM revenue_ledger rl JOIN usage_events ue ON ue.id = rl.usage_event_id
         WHERE ue.deduction_status = 'voided' AND rl.reversed_at IS NULL
         ORDER BY rl.id ASC`,
      );

      for (const row of voided.rows) {
        const updated = await queryable.query<{
          usage_event_id: string | number;
          settlement_id: string | number | null;
          amount_usdc: string | number;
          api_id: string;
          developer_id: string;
        }>(
          `UPDATE revenue_ledger
           SET reversed_at = NOW(), amount_usdc = CASE WHEN settlement_id IS NULL THEN 0 ELSE amount_usdc END
           WHERE id = $1 AND reversed_at IS NULL
           RETURNING usage_event_id, settlement_id, amount_usdc, api_id, developer_id`,
          [row.id],
        );
        const original = updated.rows[0];
        if (!original) continue;
        count += 1;
        if (original.settlement_id !== null) {
          await queryable.query(
            `INSERT INTO revenue_ledger (api_id, developer_id, amount_usdc, reversal_of_usage_event_id, created_at, reversed_at)
             VALUES ($1, $2, -$3::numeric, $4::bigint, NOW(), NOW())
             ON CONFLICT (reversal_of_usage_event_id) DO NOTHING`,
            [original.api_id, original.developer_id, original.amount_usdc, original.usage_event_id],
          );
        }
      }
      if (client) await client.query('COMMIT');
      return count;
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      throw error;
    } finally {
      client?.release();
    }
  }

  async acquireRevenueLedgerIndexerLock(): Promise<boolean> {
    if (this.writeDb.connect) {
      const client = await this.writeDb.connect();
      try {
        const lock = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext('callora:revenue-ledger-indexer')) AS locked`,
        );
        if (lock.rows[0]?.locked) {
          this.advisoryLockClient = client;
          return true;
        }
        client.release();
        return false;
      } catch {
        // SQL emulators do not implement PostgreSQL advisory locks.
        client.release();
      }
    }
    const result = await this.writeDb.query<{ name: string }>(
      `INSERT INTO indexer_checkpoints (name, last_usage_event_id, updated_at, locked_until)
       VALUES ('revenue_ledger', 0, NOW(), NOW() + INTERVAL '15 minutes')
       ON CONFLICT (name) DO UPDATE SET locked_until = NOW() + INTERVAL '15 minutes'
       WHERE indexer_checkpoints.locked_until IS NULL OR indexer_checkpoints.locked_until < NOW()
       RETURNING name`,
    );
    return result.rows.length > 0;
  }

  async releaseRevenueLedgerIndexerLock(): Promise<void> {
    if (this.advisoryLockClient) {
      const client = this.advisoryLockClient;
      this.advisoryLockClient = undefined;
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('callora:revenue-ledger-indexer'))`);
      } finally {
        client.release();
      }
      return;
    }
    await this.writeDb.query(`UPDATE indexer_checkpoints SET locked_until = NULL WHERE name = 'revenue_ledger'`);
  }

  async indexRevenueLedgerEvent(event: RevenueLedgerUsageEvent, developerId: string): Promise<boolean> {
    const statusColumn = await this.writeDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_events' AND column_name = 'deduction_status' LIMIT 1`,
    );
    const confirmationPredicate = statusColumn.rows.length ? `AND ue.deduction_status = 'confirmed'` : '';
    const result = await this.writeDb.query<{ inserted: number }>(
      `
        INSERT INTO revenue_ledger (
          api_id,
          developer_id,
          amount_usdc,
          usage_event_id,
          created_at
        )
        SELECT $1, $2, $3::numeric, ue.id, $5::timestamp
        FROM usage_events ue
        WHERE ue.id = $4::bigint
          AND ue.stellar_tx_hash IS NOT NULL
          ${confirmationPredicate}
          AND NOT EXISTS (
            SELECT 1 FROM revenue_ledger existing WHERE existing.usage_event_id = ue.id
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
    const isBackward = beforeCursor !== undefined && !afterCursor;
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

    const result = await this.readDb.query<UsageEventRow>(sql, sqlParams);
    const rows = result.rows.map(mapUsageEventRow);

    // Determine whether there is a page beyond what we're returning
    const hasMore = rows.length > normalizedLimit;
    const pageRows = hasMore ? rows.slice(0, normalizedLimit) : rows;

    // When fetching backward the DB returns items in reverse order — flip them.
    const orderedRows = isBackward ? [...pageRows].reverse() : pageRows;

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

  /**
   * Returns per-hour aggregation of call counts and revenue for a user.
   *
   * Uses `DATE_TRUNC('hour', created_at)` so the grouping is done entirely in
   * PostgreSQL. Buckets are returned in ascending chronological order.
   *
   * The hour label is returned as an ISO 8601 string (UTC) to match the shape
   * produced by InMemoryUsageEventsRepository.
   */
  async aggregateByHour(query: {
    userId: string;
    from: Date;
    to: Date;
    apiId?: string;
  }): Promise<{
    buckets: import('./usageEventsRepository.js').UsageHourBucket[];
    totalCalls: number;
    totalRevenue: bigint;
  }> {
    assertValidRange(query.from, query.to);

    const params: unknown[] = [assertNonEmpty(query.userId, 'userId')];
    const clauses: string[] = ['user_id = $1'];
    appendDateFilters(params, clauses, query.from, query.to);

    if (query.apiId) {
      params.push(query.apiId);
      clauses.push(`api_id = $${params.length}`);
    }

    const sql = `
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00.000Z"') AS hour,
        COUNT(*)::int                                                                                  AS calls,
        COALESCE(SUM(amount_usdc), 0)::text                                                           AS revenue
      FROM usage_events
      WHERE ${clauses.join(' AND ')}
      GROUP BY DATE_TRUNC('hour', created_at AT TIME ZONE 'UTC')
      ORDER BY 1 ASC
    `;

    const result = await this.readDb.query<{ hour: string; calls: number; revenue: string }>(sql, params);

    let totalCalls = 0;
    let totalRevenue = 0n;
    const buckets = result.rows.map((row) => {
      const revenue = toBigInt(row.revenue, 'revenue');
      totalCalls += row.calls;
      totalRevenue += revenue;
      return { hour: row.hour, calls: row.calls, revenue };
    });

    return { buckets, totalCalls, totalRevenue };
  }

  /**
   * Sums confirmed spend for a consumer within [from, to).
   *
   * Query uses idx_usage_events_user_created (user_id, created_at)
   * and filters for confirmed charges (stellar_tx_hash IS NOT NULL).
   */
  async sumSpendByConsumer(query: {
    userId: string;
    from: Date;
    to: Date;
  }): Promise<{ totalUnits: bigint; calls: number }> {
    assertValidRange(query.from, query.to);

    const params: unknown[] = [
      assertNonEmpty(query.userId, 'userId'),
      query.from,
      query.to,
    ];

    const sql = `
      SELECT
        COALESCE(SUM(amount_usdc), 0)::text AS total_units,
        COUNT(*)::int                       AS calls
      FROM usage_events
      WHERE user_id = $1
        AND created_at >= $2
        AND created_at < $3
        AND stellar_tx_hash IS NOT NULL
    `;

    const result = await this.readDb.query<{ total_units: string | number | bigint; calls: number | string }>(sql, params);
    const row = result.rows[0];

    const totalUnits = toBigInt(row?.total_units ?? '0', 'total_units');
    const calls = Number(row?.calls ?? 0);

    return { totalUnits, calls };
  }

  /**
   * Returns paginated billing-history rows for the consumer identified by
   * `userId`, ordered by (created_at DESC, id DESC).
   *
   * Index hit: idx_usage_events_user_created (user_id, created_at).
   * The `id DESC` tiebreak within the same timestamp uses the PK index.
   *
   * Amount formatting: amount_usdc is stored as an integer in the
   * smallest unit (1 unit = 0.0000001 USDC).  We format it as a 7-decimal
   * string in PostgreSQL to avoid BigInt division in JS.
   *
   * Status derivation:
   *   - stellar_tx_hash IS NOT NULL → "confirmed"
   *   - NULL                        → "pending"
   */
  async listChargesByConsumer(params: {
    userId: string;
    limit: number;
    cursor?: CursorPayload;
  }): Promise<ListChargesResult> {
    const { userId, limit, cursor } = params;
    const fetchLimit = limit + 1;

    // $1 = userId, $2 = fetchLimit (no cursor branch)
    // $1 = userId, $2 = ts, $3 = id, $4 = fetchLimit (cursor branch)
    let sql: string;
    let sqlParams: unknown[];

    if (cursor) {
      sql = `
        SELECT
          id::text                            AS id,
          user_id,
          api_id,
          endpoint_id,
          api_key_id,
          request_id,
          TO_CHAR(
            (amount_usdc / 10000000)::numeric(28, 7),
            'FM999999999999990.0000000'
          )                                   AS amount_usdc,
          stellar_tx_hash,
          CASE WHEN stellar_tx_hash IS NOT NULL THEN 'confirmed' ELSE 'pending' END AS status,
          created_at
        FROM usage_events
        WHERE user_id = $1
          AND (created_at < $2 OR (created_at = $2 AND id < $3))
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `;
      sqlParams = [
        assertNonEmpty(userId, 'userId'),
        cursor.timestamp,
        BigInt(cursor.id),
        fetchLimit,
      ];
    } else {
      sql = `
        SELECT
          id::text                            AS id,
          user_id,
          api_id,
          endpoint_id,
          api_key_id,
          request_id,
          TO_CHAR(
            (amount_usdc / 10000000)::numeric(28, 7),
            'FM999999999999990.0000000'
          )                                   AS amount_usdc,
          stellar_tx_hash,
          CASE WHEN stellar_tx_hash IS NOT NULL THEN 'confirmed' ELSE 'pending' END AS status,
          created_at
        FROM usage_events
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `;
      sqlParams = [assertNonEmpty(userId, 'userId'), fetchLimit];
    }

    interface ChargeRow {
      id: string;
      user_id: string;
      api_id: string;
      endpoint_id: string;
      api_key_id: string;
      request_id: string;
      amount_usdc: string;
      stellar_tx_hash: string | null;
      status: 'confirmed' | 'pending';
      created_at: Date | string;
    }

    const result = await this.readDb.query<ChargeRow>(sql, sqlParams);
    const rows = result.rows;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const charges: ConsumerChargeRow[] = page.map((row) => ({
      id: row.id,
      userId: row.user_id,
      apiId: row.api_id,
      endpointId: row.endpoint_id,
      apiKeyId: row.api_key_id,
      requestId: row.request_id,
      amountUsdc: row.amount_usdc,
      stellarTxHash: row.stellar_tx_hash,
      status: row.status,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor(
            lastRow.created_at instanceof Date
              ? lastRow.created_at
              : new Date(lastRow.created_at),
            lastRow.id,
          )
        : null;

    return { charges, nextCursor, hasMore };
  }
}
