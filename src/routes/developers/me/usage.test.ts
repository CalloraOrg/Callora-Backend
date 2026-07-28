import request from 'supertest';
import express from 'express';
import { createDeveloperMeUsageRouter } from './usage.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { InMemoryUsageEventsRepository, type UsageEvent } from '../../../repositories/usageEventsRepository.js';
import type { DeveloperRepository } from '../../../repositories/developerRepository.js';
import type { Developer } from '../../../db/schema.js';

const makeDeveloper = (overrides: Partial<Developer> = {}): Developer => ({
  id: 1,
  user_id: 'dev-1',
  name: 'Dev One',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('GET /api/developers/me/usage/summary', () => {
  let mockDeveloperRepository: jest.Mocked<DeveloperRepository>;
  let usageEventsRepository: InMemoryUsageEventsRepository;
  let app: express.Application;

  const sampleEvents: UsageEvent[] = [
    {
      id: 'event-1',
      developerId: 'dev-1',
      apiId: 'api-weather',
      endpoint: '/forecast',
      userId: 'user-a',
      occurredAt: new Date('2026-07-20T10:00:00.000Z'),
      revenue: 100n,
    },
    {
      id: 'event-2',
      developerId: 'dev-1',
      apiId: 'api-weather',
      endpoint: '/forecast',
      userId: 'user-b',
      occurredAt: new Date('2026-07-20T14:00:00.000Z'),
      revenue: 100n,
    },
    {
      id: 'event-3',
      developerId: 'dev-1',
      apiId: 'api-crypto',
      endpoint: '/prices',
      userId: 'user-c',
      occurredAt: new Date('2026-07-21T09:00:00.000Z'),
      revenue: 250n,
    },
    {
      id: 'event-other',
      developerId: 'dev-2',
      apiId: 'api-other',
      endpoint: '/data',
      userId: 'user-d',
      occurredAt: new Date('2026-07-20T12:00:00.000Z'),
      revenue: 500n,
    },
  ];

  beforeEach(() => {
    mockDeveloperRepository = {
      findByUserId: jest.fn(),
      getOrCreateByUserId: jest.fn(),
      upsertProfile: jest.fn(),
    };

    usageEventsRepository = new InMemoryUsageEventsRepository([...sampleEvents]);

    // Setup app
    app = express();
    app.use(express.json());
    app.use(
      '/api/developers/me/usage',
      createDeveloperMeUsageRouter({
        usageEventsRepository,
        developerRepository: mockDeveloperRepository,
      }),
    );
    app.use(errorHandler);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/me/usage/summary');
    expect(res.status).toBe(401);
  });

  it('returns 403 DEVELOPER_NOT_FOUND when user has no developer profile', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(undefined);

    const res = await request(app)
      .get('/api/developers/me/usage/summary')
      .set('x-user-id', 'unknown-user');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVELOPER_NOT_FOUND');
    expect(res.body.error).toBe('No developer profile found for this account');
  });

  it('returns 400 when invalid from date is provided', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?from=invalid-date')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from and to must be valid ISO date values');
  });

  it('returns 400 when invalid to date is provided', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?to=not-a-date')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from and to must be valid ISO date values');
  });

  it('returns 400 when from > to', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?from=2026-07-25T00:00:00Z&to=2026-07-20T00:00:00Z')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from must be before or equal to to');
  });

  it('returns 400 when invalid groupBy enum is provided', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?groupBy=yearly')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('groupBy must be one of: day, week, month');
  });

  it('returns 400 when empty apiId string is provided', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?apiId=   ')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('apiId must be a non-empty string');
  });

  it('returns 403 when apiId is not owned by the developer', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?apiId=api-other')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden: API does not belong to authenticated developer');
  });

  it('returns 200 with zero totals when developer has no usage events', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'empty-dev' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary')
      .set('x-user-id', 'empty-dev');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      summary: {
        totalCalls: 0,
        totalRevenue: '0',
        activeApis: 0,
      },
      breakdownByApi: [],
      buckets: [],
    });
    expect(res.body.period.from).toBeDefined();
    expect(res.body.period.to).toBeDefined();
  });

  it('returns 200 with usage summary, API breakdown, and time buckets for developer', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z&groupBy=day')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalCalls: 3,
      totalRevenue: '450',
      activeApis: 2,
    });

    expect(res.body.breakdownByApi).toEqual([
      {
        apiId: 'api-weather',
        calls: 2,
        revenue: '200',
      },
      {
        apiId: 'api-crypto',
        calls: 1,
        revenue: '250',
      },
    ]);

    expect(res.body.buckets).toEqual([
      {
        period: '2026-07-20',
        calls: 2,
        revenue: '200',
      },
      {
        period: '2026-07-21',
        calls: 1,
        revenue: '250',
      },
    ]);

    expect(res.body.period).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
    });
  });

  it('supports week and month aggregation in groupBy', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const resWeek = await request(app)
      .get('/api/developers/me/usage/summary?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z&groupBy=week')
      .set('x-user-id', 'dev-1');

    expect(resWeek.status).toBe(200);
    expect(resWeek.body.buckets).toHaveLength(1);
    expect(resWeek.body.buckets[0].calls).toBe(3);

    const resMonth = await request(app)
      .get('/api/developers/me/usage/summary?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z&groupBy=month')
      .set('x-user-id', 'dev-1');

    expect(resMonth.status).toBe(200);
    expect(resMonth.body.buckets).toEqual([
      {
        period: '2026-07-01',
        calls: 3,
        revenue: '450',
      },
    ]);
  });

  it('filters summary by specific apiId when requested', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(makeDeveloper({ user_id: 'dev-1' }));

    const res = await request(app)
      .get('/api/developers/me/usage/summary?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z&apiId=api-crypto')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalCalls: 1,
      totalRevenue: '250',
      activeApis: 1,
    });
    expect(res.body.breakdownByApi).toEqual([
      {
        apiId: 'api-crypto',
        calls: 1,
        revenue: '250',
      },
    ]);
  });
});
