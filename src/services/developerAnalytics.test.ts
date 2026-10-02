import { bucketEvents, buildDeveloperAnalytics } from './developerAnalytics';

describe('buildDeveloperAnalytics', () => {
  const dev = 'dev-123';

  const event = (id: string, ts: string, endpoint: string, revenue: string, user?: string) => ({
    id,
    developerId: dev,
    timestamp: ts,
    endpoint,
    revenue,
    userId: usr,
  });

  describe('ISO week boundaries (Sunday/Monday)', () => {
    it('places Sunday 23:59Z and Monday 00:00Z in different weeks', () => {
      const events = [
        event('e1', '2024-01-07T23:59:59Z', '/a', '1.00'),
        event('e2', '2024-01-08T00:00:00Z', '/a', '2.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'week' });
      expect(result.buckets.map((b) => b.key)).toEqual(['2024-W01', '2024-W002']);
    });

    it('groups events within the same ISO week together', () => {
      const events = [
        event('e1', '2024-01-08T00:00:00Z', '/a', '1.00'),
        event('e2', '2024-01-10T12:00:00Z', '/b', '2.00'),
        event('e3', '2024-01-14T23:59:59Z', '/c', '3.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'week' });
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].key).toEqual('2024-W002');
      expect(result.buckets[0].count).toEqual(3);
    });
  });

  describe('Leap day and month edges', () => {
    it('groups Feb 28 and Feb 29 into February', () => {
      const events = [
        event('e1', '2024-02-28T23:59:59Z', '/a', '1.00'),
        event('e2', '2024-02-29T00:00:00Z', '/a', '2.00'),
        event('e3', '2024-02-29T23:59:59Z', '/a', '3.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'month' });
      expect(result.buckets.map((b) => b.key)).toEqual(['2024-02']);
      expect(result.buckets[0].count).toEqual(3);
    });

    it('separates Dec 31 and Jan 1 into different months', () => {
      const events = [
        event('e1', '2023-12-31T23:59:59Z', '/a', '1.00'),
        event('e2', '2024-01-01T00:00:00Z', '/a', '2.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'month' });
      expect(result.buckets.map((b) => b.key)).toEqual(['2023-12', '2024-01']);
    });

    it('separates Dec 31 and Jan 1 into different ISO weeks', () => {
      const events = [
        event('e1', '2023-12-31T23:59:59Z', '/a', '1.00'),
        event('e2', '2024-01-01T00:00:00Z', '/a', '2.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'week' });
      expect(result.buckets.map((b) => b.key)).toEqual(['2023-W052', '2024-W001']);
    });
  });

  describe('revenue sums', () => {
    it('sums revenue as exact decimal strings', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', '0.10'),
        event('e2', '2024-01-01T00:00:00Z', '/a', '0.20'),
        event('e3', '2024-01-01T00:00:00Z', '/a', '0.30'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'day' });
      expect(result.buckets[0].revenue).toEqual('0.60');
    });

    it('avoids floating point drift in revenue sums', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', '0.1'),
        event('e2', '2024-01-01T00:00:00Z', '/a', '0.2'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'day' });
      expect(result.buckets[0].revenue).toEqual('0.3');
    });
  });

  describe('includeTop ordering and ties', () => {
    it('sorts top endpoints by calls then name', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/b', '1.00'),
        event('e2', '2024-01-01T00:00:00Z', '/a', '1.00'),
        event('e3', '2024-01-01T00:00:00Z', '/a', '1.00'),
        event('e4', '2024-01-01T00:00:00Z', '/c', '1.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'day', includeTop: true });
      expect(result.topEndpoints).toEqual([
        { endpoint: '/a', calls: 2 },
        { endpoint: '/b', calls: 1 },
        { endpoint: '/c', calls: 1 },
      ]);
    });

    it('sorts top users by calls then name', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', '1.00', 'user-b'),
        event('e2', '2024-01-01T00:00:00Z', '/a', '1.00', 'user-a'),
        event('e3', '2024-01-01T00:00:00Z', '/a', '1.00', 'user-a'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'day', includeTop: true });
      expect(result.topUsers).toEqual([
        { userId: 'user-a', calls: 2 },
        { userId: 'user-b', calls: 1 },
      ]);
    });

    it('respects the top limit', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', '1.00'),
        event('e2', '2024-01-01T00:00:00Z', '/b', '1.00'),
        event('e3', '2024-01-01T00:00:00Z', '/c', '1.00'),
      ];
      const result = buildDeveloperAnalytics(events, { groupBy: 'day', includeTop: true, topLimit: 2 });
      expect(result.topEndpoints).toHaveLength(2);
    });
  });

  describe('bucketEvents', () => {
    it('returns an empty array for no events', () => {
      expect(bucketEvents([], 'day')).toEqual([]);
    });

    it('produces stable day keys in UTC', () => {
      const events = [
        event('e1', '2024-01-01T00:00:00Z', '/a', '1.00'),
        event('e2', '2024-01-01T23:59:59Z', '/a', '1.00'),
      ];
      const buckets = bucketEvents(events, 'day');
      expect(buckets.map((b) => b.key)).toEqual(['2024-01-01']);
    });
  });
});
