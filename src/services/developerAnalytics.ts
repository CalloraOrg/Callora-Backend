import type { GroupBy, UsageEvent } from '../repositories/usageEventsRepository.js';

export interface AnalyticsPoint {
  period: string;
  calls: number;
  revenue: string;
}

export interface TopEndpoint {
  endpoint: string;
  calls: number;
}

export interface TopUser {
  userId: string;
  calls: number;
}

export interface AnalyticsResult {
  data: AnalyticsPoint[];
  topEndpoints?: TopEndpoint[];
  topUsers?: TopUser[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const startOfUtcWeek = (date: Date): Date => {
  const dayStart = startOfUtcDay(date);
  const weekday = dayStart.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  return new Date(dayStart.getTime() - mondayOffset * DAY_MS);
};

const startOfUtcMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const bucketStart = (date: Date, groupBy: GroupBy): Date => {
  if (groupBy === 'day') {
    return startOfUtcDay(date);
  }
  if (groupBy === 'week') {
    return startOfUtcWeek(date);
  }
  return startOfUtcMonth(date);
};

const anonymizeUserId = (userId: string): string => {
  const normalized = userId.trim();
  if (normalized.length <= 4) {
    return `user_${normalized}`;
  }
  return `user_${normalized.slice(-4)}`;
};

const topNFromMap = (
  counts: Map<string, number>,
  formatter: (key: string, value: number) => TopEndpoint | TopUser
): Array<TopEndpoint | TopUser> =>
  [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 5)
    .map(([key, value]) => formatter(key, value));

export const buildDeveloperAnalytics = (
  events: UsageEvent[],
  groupBy: GroupBy,
  includeTop: boolean
): AnalyticsResult => {
  const buckets = new Map<string, { calls: number; revenue: bigint }>();
  const endpointCounts = new Map<string, number>();
  const userCounts = new Map<string, number>();

  for (const event of events) {
    const period = isoDate(bucketStart(event.occurredAt, groupBy));
    const current = buckets.get(period) ?? { calls: 0, revenue: 0n };
    buckets.set(period, {
      calls: current.calls + 1,
      revenue: current.revenue + event.revenue,
    });

    if (includeTop) {
      endpointCounts.set(event.endpoint, (endpointCounts.get(event.endpoint) ?? 0) + 1);
      const anonymized = anonymizeUserId(event.userId);
      userCounts.set(anonymized, (userCounts.get(anonymized) ?? 0) + 1);
    }
  }

  const data: AnalyticsPoint[] = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, values]) => ({
      period,
      calls: values.calls,
      revenue: values.revenue.toString(),
    }));

  if (!includeTop) {
    return { data };
  }

  return {
    data,
    topEndpoints: topNFromMap(endpointCounts, (endpoint, calls) => ({
      endpoint,
      calls,
    })) as TopEndpoint[],
    topUsers: topNFromMap(userCounts, (userId, calls) => ({
      userId,
      calls,
    })) as TopUser[],
  };
};
