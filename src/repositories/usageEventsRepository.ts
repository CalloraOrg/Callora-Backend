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

export interface UsageStats {
  apiId: string;
  calls: number;
  revenue: bigint;
}

export interface BillingTransaction {
  id: string;
  amount: string;
  date: Date;
  type: 'charge';
  description?: string;
}

export interface BillingQuery {
  userId: string;
  from: Date;
  to: Date;
  type?: 'deposit' | 'charge' | 'withdrawal';
  limit?: number;
  offset?: number;
}

export interface UsageEventsRepository {
  findByDeveloper(query: UsageEventQuery): Promise<UsageEvent[]>;
  developerOwnsApi(developerId: string, apiId: string): Promise<boolean>;
  aggregateByDeveloper(developerId: string): Promise<UsageStats[]>;
  findBillingTransactions(query: BillingQuery): Promise<BillingTransaction[]>;
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

  async findBillingTransactions(query: BillingQuery): Promise<BillingTransaction[]> {
    // Filter events by user and date range
    const filteredEvents = this.events.filter((event) => {
      if (event.userId !== query.userId) {
        return false;
      }

      if (event.occurredAt < query.from || event.occurredAt > query.to) {
        return false;
      }

      // Only include charges if type filter is set
      if (query.type && query.type !== 'charge') {
        return false;
      }

      return true;
    });

    // Convert to billing transactions
    const transactions: BillingTransaction[] = filteredEvents.map((event) => ({
      id: event.id,
      amount: event.revenue.toString(),
      date: event.occurredAt,
      type: 'charge' as const,
      description: `API call to ${event.endpoint}`,
    }));

    // Sort by date descending (newest first)
    transactions.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return transactions.slice(offset, offset + limit);
  }
}
