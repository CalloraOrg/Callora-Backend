import request from 'supertest';
import express from 'express';
import { createDeveloperRouter } from './developerRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const mockSettlementStore = {
  create: jest.fn(),
  updateStatus: jest.fn(),
  getDeveloperSettlements: jest.fn(),
};

const mockUsageStore = {
  record: jest.fn(),
  hasEvent: jest.fn(),
  getEvents: jest.fn(),
  getUnsettledEvents: jest.fn(),
  markAsSettled: jest.fn(),
};

const app = express();
app.use(express.json());
// Mount the router
app.use('/api/developers', createDeveloperRouter({
  settlementStore: mockSettlementStore as any,
  usageStore: mockUsageStore as any,
}));
// Error handler to catch UnauthorizedError
app.use(errorHandler);

describe('GET /api/developers/revenue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettlementStore.getDeveloperSettlements.mockReturnValue([]);
    mockUsageStore.getUnsettledEvents.mockReturnValue([]);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/revenue');
    expect(res.status).toBe(401);
  });

  it('returns correct revenue summary and clamped limit', async () => {
    mockSettlementStore.getDeveloperSettlements.mockReturnValue([
      { id: 's1', developerId: 'dev-1', amount: 100, status: 'completed' },
      { id: 's2', developerId: 'dev-1', amount: 50, status: 'pending' },
    ]);
    mockUsageStore.getUnsettledEvents.mockReturnValue([
      { id: 'u1', userId: 'dev-1', amountUsdc: 25 },
      { id: 'u2', userId: 'other-dev', amountUsdc: 999 },
    ]);

    const res = await request(app)
      .get('/api/developers/revenue?limit=500')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      total_earned: 175,
      pending: 50,
      available_to_withdraw: 25,
    });
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.settlements.length).toBe(2);
  });
});
