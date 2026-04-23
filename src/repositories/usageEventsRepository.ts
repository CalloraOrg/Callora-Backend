export type GroupBy = 'day' | 'week' | 'month';

export interface UsageEvent {
  id: string;
  developerId: string;
  apiId: string;
  endpoint: string;
  userId: string;
  occurredAt: Date;
  revenue: bigint;
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
}

export interface UsageStats {
  apiId: string;
  calls: number;
  revenue: bigint;
}

export interface UsageEventsRepository {
  findByDeveloper(query: UsageEventQuery): Promise<UsageEvent[]>;
  findByUser(query: UserUsageEventQuery): Promise<UsageEvent[]>;
  developerOwnsApi(developerId: string, apiId: string): Promise<boolean>;
  aggregateByDeveloper(developerId: string): Promise<UsageStats[]>;
  aggregateByUser(query: UserUsageEventQuery): Promise<{ totalRevenue: bigint; totalCalls: number; breakdownByApi: UsageStats[] }>;
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

    // Apply limit if specified (0 means return nothing, consistent with PgUsageEventsRepository)
    if (query.limit !== undefined) {
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

  async aggregateByUser(query: UserUsageEventQuery): Promise<{ totalRevenue: bigint; totalCalls: number; breakdownByApi: UsageStats[] }> {
    const statsByApi = new Map<string, { calls: number; revenue: bigint }>();
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

      const existing = statsByApi.get(event.apiId);
      if (existing) {
        existing.calls += 1;
        existing.revenue += event.revenue;
      } else {
        statsByApi.set(event.apiId, { calls: 1, revenue: event.revenue });
      }
    }

    const breakdownByApi = [...statsByApi.entries()].map(([apiId, values]) => ({
      apiId,
      calls: values.calls,
      revenue: values.revenue,
    }));

    return {
      totalRevenue,
      totalCalls,
      breakdownByApi,
    };
  }
}
