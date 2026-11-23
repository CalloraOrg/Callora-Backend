import type { UsageEvent } from '../repositories/usageEventsRepository.js';
import { buildDeveloperAnalytics } from './developerAnalytics.js';

describe('buildDeveloperAnalytics', () => {
  const dev = 'dev-123';

  const event = (
    id: string,
    ts: string,
    endpoint: string,
    revenue: bigint,
    user = 'usr-default-0001'
  ): UsageEvent => ({
    id,
    developerId: dev,
    apiId: 'api-1',
    occurredAt: new Date(ts),
    endpoint,
    revenue,
    userId: user,
  });

  describe('ISO week boundaries (Sunday/Monday)', () => {
    it('places Sunday 23:59Z and Monday 00:00Z in different weeks', () => {
      const events = [
        event('e1', '2024-01-07T23:59:59Z', '/a', 100n),
        event('e2', '2024-01-08T00:00:00Z', '/a', 200n),
      ];
      const result = buildDeveloperAnalytics(events, 'week', false);
      expect(result.data.map((b) => b.period)).toEqual(['2024-01-01', '2024-01-08']);
      expect(result.data.map((b) => b.revenue)).toEqual(['100', '200']);
    });

    it('groups events within the same ISO week together', () => {
      const events = [
        event('e1', '2024-01-08T00:00:00Z', '/a', 100n),
        event('e2', '2024-01-10T12:00:00Z', '/b', 200n),
        event('e3', '2024-01-14T23:59:59Z', '/c', 300n),
      ];
      const result = buildDeveloperAnalytics(events, 'week', false);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].period).toEqual('2024-01-08');
      expect(result.data[0].calls).toEqual(3);
      expect(result.data[0].revenue).toEqual('600');
    });
  });

  describe('Leap day and month edges', () => {
    it('groups Feb 28 and Feb 29 into February', () => {
      const events = [
        event('e1', '2024-02-28T23:59:59Z', '/a', 100n),
        event('e2', '2024-02-29T00:00:00Z', '/a', 200n),
        event('e3', '2024-02-29T23:59:59Z', '/a', 300n),
      ];
      const result = buildDeveloperAnalytics(events, 'month', false);
      expect(result.data.map((b) => b.period)).toEqual(['2024-02-01']);
      expect(result.data[0].calls).toEqual(3);
    });

    it('separates Dec 31 and Jan 1 into different months', () => {
      const events = [
        event('e1', '2023-12-31T23:59:59Z', '/a', 100n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 200n),
      ];
      const result = buildDeveloperAnalytics(events, 'month', false);
      expect(result.data.map((b) => b.period)).toEqual(['2023-12-01', '2024-01-01']);
    });

    it('separates Dec 31 and Jan 1 into different ISO weeks', () => {
      const events = [
        event('e1', '2023-12-31T23:59:59Z', '/a', 100n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 200n),
      ];
      const result = buildDeveloperAnalytics(events, 'week', false);
      expect(result.data.map((b) => b.period)).toEqual(['2023-12-25', '2024-01-01']);
    });
  });

  describe('revenue sums', () => {
    it('sums bigint revenue without precision loss', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', 100_000n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 200_000n),
        event('e3', '2024-01-01T00:00:00Z', '/a', 300_000n),
      ];
      const result = buildDeveloperAnalytics(events, 'day', false);
      expect(result.data[0].revenue).toEqual('600000');
    });

    it('avoids floating point drift in revenue sums', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', 1n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 2n),
      ];
      const result = buildDeveloperAnalytics(events, 'day', false);
      expect(result.data[0].revenue).toEqual('3');
    });
  });

  describe('includeTop ordering and ties', () => {
    it('sorts top endpoints by calls then name', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/b', 100n),
        event('e2', '2024-01-01T00:00:00Z', '/a', 100n),
        event('e3', '2024-01-01T00:00:00Z', '/a', 100n),
        event('e4', '2024-01-01T00:00:00Z', '/c', 100n),
      ];
      const result = buildDeveloperAnalytics(events, 'day', true);
      expect(result.topEndpoints).toEqual([
        { endpoint: '/a', calls: 2 },
        { endpoint: '/b', calls: 1 },
        { endpoint: '/c', calls: 1 },
      ]);
    });

    it('sorts anonymized top users by calls then name', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', 100n, 'usr-000b'),
        event('e2', '2024-01-01T00:00:00Z', '/a', 100n, 'usr-000a'),
        event('e3', '2024-01-01T00:00:00Z', '/a', 100n, 'usr-000a'),
      ];
      const result = buildDeveloperAnalytics(events, 'day', true);
      expect(result.topUsers).toEqual([
        { userId: 'user_000a', calls: 2 },
        { userId: 'user_000b', calls: 1 },
      ]);
    });

    it('caps top lists at 5 entries', () => {
      const events = ['/a', '/b', '/c', '/d', '/e', '/f'].map((ep, i) =>
        event(`e${i}`, '2024-01-01T00:00:00Z', ep, 100n)
      );
      const result = buildDeveloperAnalytics(events, 'day', true);
      expect(result.topEndpoints).toHaveLength(5);
    });
  });

  describe('empty and UTC day bucketing', () => {
    it('returns an empty data array for no events', () => {
      expect(buildDeveloperAnalytics([], 'day', false)).toEqual({ data: [] });
    });

    it('produces stable day keys in UTC', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', 100n),
        event('e2', '2024-01-01T23:59:59Z', '/a', 100n),
      ];
      const result = buildDeveloperAnalytics(events, 'day', false);
      expect(result.data.map((b) => b.period)).toEqual(['2024-01-01']);
    });
  });
});
