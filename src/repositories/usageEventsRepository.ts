import { encodeCursor, type CursorPayload } from '../lib/cursorPagination.js';

export type GroupBy = 'hour' | 'day' | 'week' | 'month';

export interface UsageEvent {
  id: string;
  developerId: string;
  apiId: string;
  endpoint: string;
  userId: string;
  occurredAt: Date;
  revenue: bigint;
  stellarTxHash?: string | null;
}

/**
 * A single row in the consumer billing-history feed.
 * `amountUsdc` is the human-readable 7-decimal string (e.g. "0.0012345").
 * `status` is derived from stellar_tx_hash: "confirmed" when the hash is
 * present, "pending" otherwise.
 */
export interface ConsumerChargeRow {
  id: string;
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
  requestId: string;
  amountUsdc: string;
  stellarTxHash: string | null;
  status: 'confirmed' | 'pending';
  createdAt: Date;
}

export interface ListChargesResult {
  charges: ConsumerChargeRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface UsageEventQuery {
  developerId: string;
  from: Date;
  to: Date;
  apiId?: string;
}

export interface UserUsageEventQuery {
  userId: string;
  from: Date;
  to: Date;
  apiId?: string;
  limit?: number;
  offset?: number;
  groupBy?: GroupBy;
  cursor?: string;}

export interface UsageStats {
  apiId: string;
  calls: number;
  revenue: bigint;
}

export interface UsageBucket {
  period: string;
  calls: number;
  revenue: bigint;
}

export interface UsageHourBucket {
  /** ISO 8601 datetime truncated to the hour, e.g. "2026-07-28T10:00:00.000Z" */
  hour: string;
  calls: number;
  revenue: bigint;
}

export interface UsageEventsRepository {
  findByDeveloper(query: UsageEventQuery): Promise<UsageEvent[]>;
  findByUser(query: UserUsageEventQuery): Promise<UsageEvent[]>;
  developerOwnsApi(developerId: string, apiId: string): Promise<boolean>;
  aggregateByDeveloper(developerId: string): Promise<UsageStats[]>;
  aggregateByUser(query: UserUsageEventQuery): Promise<{
    totalRevenue: bigint;
    totalCalls: number;
    breakdownByApi: UsageStats[];
    buckets?: UsageBucket[];
  }>;
  /**
   * Returns per-hour call counts and revenue for the authenticated user
   * within [from, to]. Buckets are sorted ascending by hour.
   */
  aggregateByHour(query: {
    userId: string;
    from: Date;
    to: Date;
    apiId?: string;
  }): Promise<{
    buckets: UsageHourBucket[];
    totalCalls: number;
    totalRevenue: bigint;
  }>;
  getTopEndpoints(query: {
    userId: string;
    from: Date;
    to: Date;
    apiId?: string;
    limit: number;
  }): Promise<Array<{ endpoint: string; calls: number; revenue: bigint }>>;
  sumSpendByConsumer(query: {
    userId: string;
    from: Date;
    to: Date;
  }): Promise<{ totalUnits: bigint; calls: number }>;
  /**
   * Returns paginated billing-history rows for the consumer identified by
   * `userId`, ordered by (created_at DESC, id DESC) for stable keyset
   * pagination.  Fetches `limit + 1` rows to detect whether a next page
   * exists without a COUNT(*).
   *
   * `cursor` is the opaque cursor produced by `encodeCursor` from the last
   * row of the previous page.  When absent the first page is returned.
   */
  listChargesByConsumer(params: {
    userId: string;
    limit: number;
    cursor?: CursorPayload;
  }): Promise<ListChargesResult>;
}

export class InMemoryUsageEventsRepository implements UsageEventsRepository {
  constructor(private readonly events: UsageEvent[] = []) {}

  async findByDeveloper(query: UsageEventQuery): Promise<UsageEvent[]> {
    return this.events.filter((event) => {
      if (event.developerId !== query.developerId) {
        return false;
      }

      if (query.apiId && event.apiId !== query.apiId) {
        return false;
      }

      return event.occurredAt >= query.from && event.occurredAt <= query.to;
    });
  }

  async findByUser(query: UserUsageEventQuery): Promise<UsageEvent[]> {
    let filtered = this.events.filter((event) => {
      if (event.userId !== query.userId) {
        return false;
      }

      if (query.apiId && event.apiId !== query.apiId) {
        return false;
      }

      return event.occurredAt >= query.from && event.occurredAt <= query.to;
    });

    // Apply pagination
    if (typeof query.offset === 'number' && query.offset > 0) {
      filtered = filtered.slice(query.offset);
    }
    if (typeof query.limit === 'number') {
      if (query.limit <= 0) {
        return [];
      }
      filtered = filtered.slice(0, query.limit);
    }

    return filtered;
  }

  async developerOwnsApi(developerId: string, apiId: string): Promise<boolean> {
    return this.events.some(
      (event) => event.developerId === developerId && event.apiId === apiId
    );
  }

  async aggregateByDeveloper(developerId: string): Promise<UsageStats[]> {
    const statsByApi = new Map<string, { calls: number; revenue: bigint }>();
    for (const event of this.events) {
      if (event.developerId !== developerId) {
        continue;
      }
      const existing = statsByApi.get(event.apiId);
      if (existing) {
        existing.calls += 1;
        existing.revenue += event.revenue;
      } else {
        statsByApi.set(event.apiId, { calls: 1, revenue: event.revenue });
      }
    }

    return [...statsByApi.entries()].map(([apiId, values]) => ({
      apiId,
      calls: values.calls,
      revenue: values.revenue,
    }));
  }

  async aggregateByUser(query: UserUsageEventQuery): Promise<{
    totalRevenue: bigint;
    totalCalls: number;
    breakdownByApi: UsageStats[];
    buckets?: UsageBucket[];
  }> {
    const statsByApi = new Map<string, { calls: number; revenue: bigint }>();
    const bucketStats = new Map<string, { calls: number; revenue: bigint }>();
    let totalCalls = 0;
    let totalRevenue = BigInt(0);

    for (const event of this.events) {
      if (event.userId !== query.userId) {
        continue;
      }

      if (event.occurredAt < query.from || event.occurredAt > query.to) {
        continue;
      }

      if (query.apiId && event.apiId !== query.apiId) {
        continue;
      }

      totalCalls += 1;
      totalRevenue += event.revenue;

      // Api breakdown
      const existingApi = statsByApi.get(event.apiId);
      if (existingApi) {
        existingApi.calls += 1;
        existingApi.revenue += event.revenue;
      } else {
        statsByApi.set(event.apiId, { calls: 1, revenue: event.revenue });
      }

      // Bucketing
      if (query.groupBy) {
        const period = this.getPeriodString(event.occurredAt, query.groupBy);
        const existingBucket = bucketStats.get(period);
        if (existingBucket) {
          existingBucket.calls += 1;
          existingBucket.revenue += event.revenue;
        } else {
          bucketStats.set(period, { calls: 1, revenue: event.revenue });
        }
      }
    }

    const breakdownByApi = [...statsByApi.entries()].map(([apiId, values]) => ({
      apiId,
      calls: values.calls,
      revenue: values.revenue,
    }));

    let buckets: UsageBucket[] | undefined;
    if (query.groupBy) {
      buckets = [...bucketStats.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, values]) => ({
          period,
          calls: values.calls,
          revenue: values.revenue,
        }));
    }

    return {
      totalRevenue,
      totalCalls,
      breakdownByApi,
      buckets,
    };
  }

  async aggregateByHour(query: {
    userId: string;
    from: Date;
    to: Date;
    apiId?: string;
  }): Promise<{
    buckets: UsageHourBucket[];
    totalCalls: number;
    totalRevenue: bigint;
  }> {
    const bucketMap = new Map<string, { calls: number; revenue: bigint }>();
    let totalCalls = 0;
    let totalRevenue = 0n;

    for (const event of this.events) {
      if (event.userId !== query.userId) continue;
      if (query.apiId && event.apiId !== query.apiId) continue;
      if (event.occurredAt < query.from || event.occurredAt > query.to) continue;

      totalCalls += 1;
      totalRevenue += event.revenue;

      const hour = this.getPeriodString(event.occurredAt, 'hour');
      const bucket = bucketMap.get(hour) ?? { calls: 0, revenue: 0n };
      bucketMap.set(hour, { calls: bucket.calls + 1, revenue: bucket.revenue + event.revenue });
    }

    const buckets: UsageHourBucket[] = [...bucketMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, stats]) => ({ hour, calls: stats.calls, revenue: stats.revenue }));

    return { buckets, totalCalls, totalRevenue };
  }

  async getTopEndpoints(query: {
    userId: string;
    from: Date;
    to: Date;
    apiId?: string;
    limit: number;
  }): Promise<Array<{ endpoint: string; calls: number; revenue: bigint }>> {
    const filtered = this.events.filter((event) => {
      if (event.userId !== query.userId) {
        return false;
      }
      if (query.apiId && event.apiId !== query.apiId) {
        return false;
      }
      return event.occurredAt >= query.from && event.occurredAt <= query.to;
    });

    const counts = new Map<string, { calls: number; revenue: bigint }>();
    for (const event of filtered) {
      const existing = counts.get(event.endpoint) ?? { calls: 0, revenue: 0n };
      counts.set(event.endpoint, {
        calls: existing.calls + 1,
        revenue: existing.revenue + event.revenue,
      });
    }

    return [...counts.entries()]
      .sort((a, b) => {
        if (b[1].calls !== a[1].calls) {
          return b[1].calls - a[1].calls;
        }
        return a[0].localeCompare(b[0]);
      })
      .slice(0, query.limit)
      .map(([endpoint, stats]) => ({
        endpoint,
        calls: stats.calls,
        revenue: stats.revenue,
      }));
  }

  private getPeriodString(date: Date, groupBy: GroupBy): string {
    const d = new Date(date);
    if (groupBy === 'hour') {
      return d.toISOString().slice(0, 13) + ':00:00.000Z';
    }
    if (groupBy === 'day') {
      return d.toISOString().slice(0, 10);
    }
    if (groupBy === 'week') {
      // Simple week start (Monday)
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(d.setUTCDate(diff));
      return weekStart.toISOString().slice(0, 10);
    }
    if (groupBy === 'month') {
      return d.toISOString().slice(0, 7) + '-01';
    }
    return d.toISOString().slice(0, 10);
  }

  async sumSpendByConsumer(query: {
    userId: string;
    from: Date;
    to: Date;
  }): Promise<{ totalUnits: bigint; calls: number }> {
    let totalUnits = 0n;
    let calls = 0;

    for (const event of this.events) {
      if (event.userId !== query.userId) {
        continue;
      }

      const eventTime = (event as unknown as { createdAt?: Date }).createdAt ?? event.occurredAt;
      if (eventTime < query.from || eventTime >= query.to) {
        continue;
      }

      if (!event.stellarTxHash) {
        continue;
      }

      calls += 1;
      const amount = (event as unknown as { amount?: bigint }).amount ?? event.revenue ?? 0n;
      totalUnits += amount;
    }

    return { totalUnits, calls };
  }

  async listChargesByConsumer(params: {
    userId: string;
    limit: number;
    cursor?: CursorPayload;
  }): Promise<ListChargesResult> {
    // Filter to this consumer's rows only
    let filtered = this.events.filter((e) => e.userId === params.userId);

    // Apply keyset condition when a cursor is present: keep rows that come
    // *before* the cursor in DESC order, i.e. (created_at, id) < cursor.
    if (params.cursor) {
      const { timestamp: ts, id: cursorId } = params.cursor;
      filtered = filtered.filter((e) => {
        const eTime = (e as unknown as { createdAt?: Date }).createdAt ?? e.occurredAt;
        if (eTime < ts) return true;
        if (eTime.getTime() === ts.getTime()) {
          return String(e.id) < cursorId;
        }
        return false;
      });
    }

    // Sort DESC by (createdAt, id) — mirrors the SQL ORDER BY
    filtered = [...filtered].sort((a, b) => {
      const aTime = ((a as unknown as { createdAt?: Date }).createdAt ?? a.occurredAt).getTime();
      const bTime = ((b as unknown as { createdAt?: Date }).createdAt ?? b.occurredAt).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0;
    });

    // Lookahead by one to detect next page
    const lookahead = filtered.slice(0, params.limit + 1);
    const hasMore = lookahead.length > params.limit;
    const page = hasMore ? lookahead.slice(0, params.limit) : lookahead;

    const charges: ConsumerChargeRow[] = page.map((e) => {
      const createdAt = (e as unknown as { createdAt?: Date }).createdAt ?? e.occurredAt;
      const rawAmount = (e as unknown as { amount?: bigint }).amount ?? e.revenue ?? 0n;
      // Format as 7-decimal USDC string from smallest-unit bigint
      const units = rawAmount;
      const intPart = units / 10_000_000n;
      const fracPart = units % 10_000_000n;
      const amountUsdc = `${intPart}.${String(fracPart).padStart(7, '0')}`;
      return {
        id: String(e.id),
        userId: e.userId,
        apiId: e.apiId,
        endpointId: e.endpoint,
        apiKeyId: (e as unknown as { apiKeyId?: string }).apiKeyId ?? '',
        requestId: (e as unknown as { requestId?: string }).requestId ?? '',
        amountUsdc,
        stellarTxHash: e.stellarTxHash ?? null,
        status: e.stellarTxHash ? 'confirmed' : 'pending',
        createdAt,
      };
    });

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor(
            (lastRow as unknown as { createdAt?: Date }).createdAt ?? lastRow.occurredAt,
            String(lastRow.id),
          )
        : null;

    return { charges, nextCursor, hasMore };
  }
}
