import { buildDeveloperAnalytics } from './developerAnalytics.js';
import type { UsageEvent } from '../repositories/usageEventsRepository.js';

describe('buildDeveloperAnalytics', () => {
  const event = (
    id: string,
    timestamp: string,
    endpoint: string,
    revenue: bigint,
    userId = 'user-test',
  ): UsageEvent => ({
    id,
    developerId: 'dev-123',
    apiId: 'api-123',
    occurredAt: new Date(timestamp),
    endpoint,
    revenue,
    userId,
  });

  describe('UTC week boundaries', () => {
    it('places Sunday 23:59Z and Monday 00:00Z in different weeks', () => {
      const events = [
        event('e1', '2024-01-07T23:59:59Z', '/a', 1n),
        event('e2', '2024-01-08T00:00:00Z', '/a', 2n),
      ];
      expect(buildDeveloperAnalytics(events, 'week', false).data).toEqual([
        { period: '2024-01-01', calls: 1, revenue: '1' },
        { period: '2024-01-08', calls: 1, revenue: '2' },
      ]);
    });

    it('aggregates calls and revenue within the same Monday-based week', () => {
      const events = [
        event('e1', '2024-01-08T00:00:00Z', '/a', 1n),
        event('e2', '2024-01-10T12:00:00Z', '/b', 2n),
        event('e3', '2024-01-14T23:59:59Z', '/c', 3n),
      ];
      expect(buildDeveloperAnalytics(events, 'week', false).data).toEqual([
        { period: '2024-01-08', calls: 3, revenue: '6' },
      ]);
    });
  });

  describe('leap day and year edges', () => {
    it('includes leap day in February', () => {
      const events = [
        event('e1', '2024-02-28T23:59:59Z', '/a', 1n),
        event('e2', '2024-02-29T00:00:00Z', '/a', 2n),
        event('e3', '2024-02-29T23:59:59Z', '/a', 3n),
      ];
      expect(buildDeveloperAnalytics(events, 'month', false).data).toEqual([
        { period: '2024-02-01', calls: 3, revenue: '6' },
      ]);
    });

    it('separates December and January', () => {
      const events = [
        event('e1', '2023-12-31T23:59:59Z', '/a', 1n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 2n),
      ];
      expect(buildDeveloperAnalytics(events, 'month', false).data).toEqual([
        { period: '2023-12-01', calls: 1, revenue: '1' },
        { period: '2024-01-01', calls: 1, revenue: '2' },
      ]);
    });

    it('separates weeks across the year boundary', () => {
      const events = [
        event('e1', '2023-12-31T23:59:59Z', '/a', 1n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 2n),
      ];
      expect(buildDeveloperAnalytics(events, 'week', false).data).toEqual([
        { period: '2023-12-25', calls: 1, revenue: '1' },
        { period: '2024-01-01', calls: 1, revenue: '2' },
      ]);
    });
  });

  it('sums integer-unit revenue exactly', () => {
    const events = [
      event('e1', '2024-01-01T00:00:00Z', '/a', 10n),
      event('e2', '2024-01-01T00:00:00Z', '/a', 20n),
      event('e3', '2024-01-01T00:00:00Z', '/a', 30n),
    ];
    expect(buildDeveloperAnalytics(events, 'day', false).data).toEqual([
      { period: '2024-01-01', calls: 3, revenue: '60' },
    ]);
  });

  it('does not lose revenue above the safe integer boundary', () => {
    const events = [
      event('e1', '2024-01-01T00:00:00Z', '/a', 9007199254740993n),
      event('e2', '2024-01-01T00:00:00Z', '/a', 2n),
    ];
    expect(buildDeveloperAnalytics(events, 'day', false).data[0].revenue).toBe('9007199254740995');
  });

  it('sorts top endpoints by calls then name', () => {
    const events = [
      event('e1', '2024-01-01T00:00:00Z', '/b', 1n),
      event('e2', '2024-01-01T00:00:00Z', '/a', 1n),
      event('e3', '2024-01-01T00:00:00Z', '/a', 1n),
      event('e4', '2024-01-01T00:00:00Z', '/c', 1n),
    ];
    expect(buildDeveloperAnalytics(events, 'day', true).topEndpoints).toEqual([
      { endpoint: '/a', calls: 2 },
      { endpoint: '/b', calls: 1 },
      { endpoint: '/c', calls: 1 },
    ]);
  });

  it('ranks anonymized users without exposing their original identifiers', () => {
    const events = [
      event('e1', '2024-01-01T00:00:00Z', '/a', 1n, 'user-b'),
      event('e2', '2024-01-01T00:00:00Z', '/a', 1n, 'user-a'),
      event('e3', '2024-01-01T00:00:00Z', '/a', 1n, 'user-a'),
    ];
    expect(buildDeveloperAnalytics(events, 'day', true).topUsers).toEqual([
      { userId: 'user_er-a', calls: 2 },
      { userId: 'user_er-b', calls: 1 },
    ]);
  });

  it('bounds tied top endpoints to five in deterministic order', () => {
    const events = ['/f', '/e', '/d', '/c', '/b', '/a'].map((endpoint, index) =>
      event(`e${index}`, '2024-01-01T00:00:00Z', endpoint, 1n),
    );
    expect(buildDeveloperAnalytics(events, 'day', true).topEndpoints).toEqual([
      { endpoint: '/a', calls: 1 },
      { endpoint: '/b', calls: 1 },
      { endpoint: '/c', calls: 1 },
      { endpoint: '/d', calls: 1 },
      { endpoint: '/e', calls: 1 },
    ]);
  });

  it('returns no daily aggregates for no events', () => {
    expect(buildDeveloperAnalytics([], 'day', false)).toEqual({ data: [] });
  });

  it('buckets offset timestamps by UTC day', () => {
    const events = [
      event('e1', '2024-01-01T23:30:00-01:00', '/a', 1n),
      event('e2', '2024-01-02T00:45:00Z', '/a', 2n),
    ];
    expect(buildDeveloperAnalytics(events, 'day', false).data).toEqual([
      { period: '2024-01-02', calls: 2, revenue: '3' },
    ]);
  });
});
