import { UsageEvent, UsageStats } from '../types/usage.js';

export class UsageEventsRepository {
  private events: UsageEvent[] = [];

  constructor() {
    this.seedMockData();
  }

  private seedMockData() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    this.events = [
      {
        id: '1',
        userId: 'user1',
        walletAddress: '0x1234567890123456789012345678901234567890',
        apiEndpoint: '/api/v1/chat',
        method: 'POST',
        timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        cost: 0.002,
        statusCode: 200,
        responseTime: 150
      },
      {
        id: '2',
        userId: 'user1',
        walletAddress: '0x1234567890123456789012345678901234567890',
        apiEndpoint: '/api/v1/analyze',
        method: 'POST',
        timestamp: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        cost: 0.005,
        statusCode: 200,
        responseTime: 320
      },
      {
        id: '3',
        userId: 'user1',
        walletAddress: '0x1234567890123456789012345678901234567890',
        apiEndpoint: '/api/v1/chat',
        method: 'POST',
        timestamp: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        cost: 0.002,
        statusCode: 200,
        responseTime: 180
      },
      {
        id: '4',
        userId: 'user2',
        walletAddress: '0x9876543210987654321098765432109876543210',
        apiEndpoint: '/api/v1/chat',
        method: 'POST',
        timestamp: new Date(now.getTime() - 3 * 60 * 60 * 1000),
        cost: 0.002,
        statusCode: 200,
        responseTime: 120
      }
    ];
  }

  async getUsageByUserId(
    userId: string,
    fromDate: Date,
    toDate: Date,
    limit?: number
  ): Promise<{ events: UsageEvent[]; stats: UsageStats }> {
    let filteredEvents = this.events.filter(event => 
      event.userId === userId &&
      event.timestamp >= fromDate &&
      event.timestamp <= toDate
    );

    if (limit && limit > 0) {
      filteredEvents = filteredEvents.slice(0, limit);
    }

    const totalSpent = filteredEvents.reduce((sum, event) => sum + event.cost, 0);
    const totalCalls = filteredEvents.length;

    const breakdown: { [key: string]: { calls: number; cost: number; avgResponseTime: number } } = {};
    
    filteredEvents.forEach(event => {
      if (!breakdown[event.apiEndpoint]) {
        breakdown[event.apiEndpoint] = {
          calls: 0,
          cost: 0,
          avgResponseTime: 0
        };
      }
      
      const api = breakdown[event.apiEndpoint];
      api.calls += 1;
      api.cost += event.cost;
      api.avgResponseTime = (api.avgResponseTime * (api.calls - 1) + event.responseTime) / api.calls;
    });

    const stats: UsageStats = {
      totalSpent,
      totalCalls,
      period: {
        from: fromDate,
        to: toDate
      },
      breakdown
    };

    return { events: filteredEvents, stats };
  }

  async getUsageByWalletAddress(
    walletAddress: string,
    fromDate: Date,
    toDate: Date,
    limit?: number
  ): Promise<{ events: UsageEvent[]; stats: UsageStats }> {
    let filteredEvents = this.events.filter(event => 
      event.walletAddress === walletAddress &&
      event.timestamp >= fromDate &&
      event.timestamp <= toDate
    );

    if (limit && limit > 0) {
      filteredEvents = filteredEvents.slice(0, limit);
    }

    const totalSpent = filteredEvents.reduce((sum, event) => sum + event.cost, 0);
    const totalCalls = filteredEvents.length;

    const breakdown: { [key: string]: { calls: number; cost: number; avgResponseTime: number } } = {};
    
    filteredEvents.forEach(event => {
      if (!breakdown[event.apiEndpoint]) {
        breakdown[event.apiEndpoint] = {
          calls: 0,
          cost: 0,
          avgResponseTime: 0
        };
      }
      
      const api = breakdown[event.apiEndpoint];
      api.calls += 1;
      api.cost += event.cost;
      api.avgResponseTime = (api.avgResponseTime * (api.calls - 1) + event.responseTime) / api.calls;
    });

    const stats: UsageStats = {
      totalSpent,
      totalCalls,
      period: {
        from: fromDate,
        to: toDate
      },
      breakdown
    };

    return { events: filteredEvents, stats };
  }
}
