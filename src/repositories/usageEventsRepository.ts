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

export interface UsageEventsRepository {
  findByDeveloper(query: UsageEventQuery): Promise<UsageEvent[]>;
  developerOwnsApi(developerId: string, apiId: string): Promise<boolean>;
  aggregateByDeveloper(developerId: string): Promise<UsageStats[]>;
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
}
