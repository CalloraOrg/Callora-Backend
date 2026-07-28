import request from 'supertest';
import express from 'express';
import { createDeveloperUsageSummaryRouter } from './usage.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import type { Developer } from '../../../db/schema.js';
import type { UsageEventsRepository, UsageEvent, UserUsageEventQuery } from '../../../repositories/usageEventsRepository.js';
import type { DeveloperRepository } from '../../../repositories/developerRepository.js';

const makeDeveloper = (overrides: Partial<Developer> = {}): Developer => ({
  id: 1,
  user_id: 'dev-1',
  name: null,
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const mockUsageEventsRepository = {
  findByDeveloper: jest.fn(),
  findByUser: jest.fn(),
  developerOwnsApi: jest.fn(),
  aggregateByDeveloper: jest.fn(),
  aggregateByUser: jest.fn(),
  getTopEndpoints: jest.fn(),
};

const mockDeveloperRepository = {
  findByUserId: jest.fn(),
  getOrCreateByUserId: jest.fn(),
  upsertProfile: jest.fn(),
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/developers/me/usage',
    createDeveloperUsageSummaryRouter({
      usageEventsRepository: mockUsageEventsRepository as unknown as UsageEventsRepository,
      developerRepository: mockDeveloperRepository as unknown as DeveloperRepository,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('GET /api/developers/me/usage/summary', () => {
  const app = createTestApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeveloperRepository.findByUserId.mockImplementation((userId: string) =>
      userId === 'dev-1'
        ? Promise.resolve(makeDeveloper({ user_id: 'dev-1' }))
        : Promise.resolve(undefined),
    );
    mockUsageEventsRepository.aggregateByUser.mockResolvedValue({
      totalCalls: 0,
      totalRevenue: BigInt(0),
      breakdownByApi: [],
    });
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/me/usage/summary');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the authenticated user has no developer profile', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(undefined);

    const res = await request(app)
      .get('/api/developers/me/usage/summary')
      .set('x-user-id', 'no-profile-user');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVELOPER_NOT_FOUND');
  });

  it('returns usage summary with default 30-day period', async () => {
    mockUsageEventsRepository.aggregateByUser.mockResolvedValue({
      totalCalls: 150,
      totalRevenue: BigInt(125000000),
      breakdownByApi: [
        { apiId: 'api-1', calls: 100, revenue: BigInt(80000000) },
        { apiId: 'api-2', calls: 50, revenue: BigInt(45000000) },
      ],
    });

    const res = await request(app)
      .get('/api/developers/me/usage/summary')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.total_calls).toBe(150);
    expect(res.body.total_cost_usdc).toBe('125000000');
    expect(res.body.breakdown_by_api).toHaveLength(2);
    expect(res.body.breakdown_by_api[0]).toEqual({
      api_id: 'api-1',
      calls: 100,
      cost_usdc: '80000000',
    });
    expect(res.body.period).toBeDefined();
    expect(res.body.period.from).toBeDefined();
    expect(res.body.period.to).toBeDefined();
  });

  it('passes custom date range to aggregateByUser', async () => {
    const from = '2026-06-01T00:00:00.000Z';
    const to = '2026-06-30T23:59:59.999Z';

    const res = await request(app)
      .get(`/api/developers/me/usage/summary?from=${from}&to=${to}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(mockUsageEventsRepository.aggregateByUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'dev-1',
        from: new Date(from),
        to: new Date(to),
      }),
    );
    expect(res.body.period.from).toBe(from);
    expect(res.body.period.to).toBe(to);
  });

  it('passes apiId filter to aggregateByUser', async () => {
    const res = await request(app)
      .get('/api/developers/me/usage/summary?apiId=api-1')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(mockUsageEventsRepository.aggregateByUser).toHaveBeenCalledWith(
      expect.objectContaining({
        apiId: 'api-1',
      }),
    );
  });

  it('returns 400 when from is after to', async () => {
    const from = '2026-07-01T00:00:00.000Z';
    const to = '2026-06-01T00:00:00.000Z';

    const res = await request(app)
      .get(`/api/developers/me/usage/summary?from=${from}&to=${to}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid date format', async () => {
    const res = await request(app)
      .get('/api/developers/me/usage/summary?from=not-a-date')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns empty summary when no usage events exist', async () => {
    const res = await request(app)
      .get('/api/developers/me/usage/summary')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.total_calls).toBe(0);
    expect(res.body.total_cost_usdc).toBe('0');
    expect(res.body.breakdown_by_api).toEqual([]);
  });

  it('returns 500 when aggregateByUser throws', async () => {
    mockUsageEventsRepository.aggregateByUser.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .get('/api/developers/me/usage/summary')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('ignores empty apiId query parameter', async () => {
    const res = await request(app)
      .get('/api/developers/me/usage/summary?apiId=')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(mockUsageEventsRepository.aggregateByUser).toHaveBeenCalledWith(
      expect.objectContaining({
        apiId: undefined,
      }),
    );
  });
});
