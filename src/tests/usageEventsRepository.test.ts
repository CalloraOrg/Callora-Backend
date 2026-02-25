import { UsageEventsRepository } from '../repositories/usageEventsRepository.js';

describe('UsageEventsRepository', () => {
  let repository: UsageEventsRepository;

  beforeEach(() => {
    repository = new UsageEventsRepository();
  });

  describe('getUsageByUserId', () => {
    it('should return usage events for a valid user', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');

      const result = await repository.getUsageByUserId('user1', fromDate, toDate);

      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('stats');
      expect(Array.isArray(result.events)).toBe(true);
      expect(result.stats).toHaveProperty('totalSpent');
      expect(result.stats).toHaveProperty('totalCalls');
      expect(result.stats).toHaveProperty('period');
      expect(result.stats).toHaveProperty('breakdown');
    });

    it('should return empty results for non-existent user', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');

      const result = await repository.getUsageByUserId('nonexistent', fromDate, toDate);

      expect(result.events).toHaveLength(0);
      expect(result.stats.totalSpent).toBe(0);
      expect(result.stats.totalCalls).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');

      const resultWithoutLimit = await repository.getUsageByUserId('user1', fromDate, toDate);
      const resultWithLimit = await repository.getUsageByUserId('user1', fromDate, toDate, 1);

      expect(resultWithLimit.events.length).toBeLessThanOrEqual(1);
      expect(resultWithLimit.events.length).toBeLessThanOrEqual(resultWithoutLimit.events.length);
    });

    it('should calculate correct statistics', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');

      const result = await repository.getUsageByUserId('user1', fromDate, toDate);

      const expectedTotalSpent = result.events.reduce((sum, event) => sum + event.cost, 0);
      const expectedTotalCalls = result.events.length;

      expect(result.stats.totalSpent).toBe(expectedTotalSpent);
      expect(result.stats.totalCalls).toBe(expectedTotalCalls);
    });

    it('should provide breakdown by API endpoint', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');

      const result = await repository.getUsageByUserId('user1', fromDate, toDate);

      expect(typeof result.stats.breakdown).toBe('object');
      
      if (result.events.length > 0 && result.stats.breakdown) {
        const firstEvent = result.events[0];
        expect(result.stats.breakdown[firstEvent.apiEndpoint]).toBeDefined();
        
        const apiBreakdown = result.stats.breakdown[firstEvent.apiEndpoint];
        expect(apiBreakdown).toHaveProperty('calls');
        expect(apiBreakdown).toHaveProperty('cost');
        expect(apiBreakdown).toHaveProperty('avgResponseTime');
      }
    });
  });

  describe('getUsageByWalletAddress', () => {
    it('should return usage events for a valid wallet address', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');
      const walletAddress = '0x1234567890123456789012345678901234567890';

      const result = await repository.getUsageByWalletAddress(walletAddress, fromDate, toDate);

      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('stats');
      expect(Array.isArray(result.events)).toBe(true);
      expect(result.stats).toHaveProperty('totalSpent');
      expect(result.stats).toHaveProperty('totalCalls');
      expect(result.stats).toHaveProperty('period');
      expect(result.stats).toHaveProperty('breakdown');
    });

    it('should return empty results for non-existent wallet address', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');
      const walletAddress = '0x0000000000000000000000000000000000000000';

      const result = await repository.getUsageByWalletAddress(walletAddress, fromDate, toDate);

      expect(result.events).toHaveLength(0);
      expect(result.stats.totalSpent).toBe(0);
      expect(result.stats.totalCalls).toBe(0);
    });

    it('should filter by date range correctly', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const walletAddress = '0x1234567890123456789012345678901234567890';

      const result = await repository.getUsageByWalletAddress(walletAddress, oneHourAgo, now);

      result.events.forEach(event => {
        expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(oneHourAgo.getTime());
        expect(event.timestamp.getTime()).toBeLessThanOrEqual(now.getTime());
      });
    });

    it('should calculate correct average response times', async () => {
      const fromDate = new Date('2024-01-01T00:00:00.000Z');
      const toDate = new Date('2024-12-31T23:59:59.999Z');
      const walletAddress = '0x1234567890123456789012345678901234567890';

      const result = await repository.getUsageByWalletAddress(walletAddress, fromDate, toDate);

      if (result.stats.breakdown) {
        Object.values(result.stats.breakdown).forEach(apiBreakdown => {
          expect(apiBreakdown.avgResponseTime).toBeGreaterThan(0);
          expect(typeof apiBreakdown.avgResponseTime).toBe('number');
        });
      }
    });
  });
});
