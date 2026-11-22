import express from 'express';
import request from 'supertest';
import { registerDeveloperAnalyticsRoutes } from './developerAnalyticsRoutes.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { UsageEvent, UsageEventsRepository } from '../repositories/usageEventsRepository.js';
import type { Api, Developer } from '../db/schema.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

const sampleDeveloper: Developer = {
  id: 42,
  user_id: USER_ID,
  name: 'Acme Dev',
  website: 'https://acme.example.com',
  description: 'Sample developer',
  category: 'data',
  plan_overrides: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const sampleApiWithUsage: Api = {
  id: 101,
  developer_id: sampleDeveloper.id,
  name: 'Weather API',
  description: 'Forecasts',
  base_url: 'https://weather.example.com',
  logo_url: null,
  category: 'weather',
  status: 'active',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
  deleted_at: null,
};

const sampleApiWithoutUsage: Api = {
  id: 102,
  developer_id: sampleDeveloper.id,
  name: 'Draft API',
  description: null,
  base_url: 'https://draft.example.com',
  logo_url: null,
  category: 'tools',
  status: 'draft',
  created_at: new Date('2026-01-02T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
  deleted_at: null,
};

function createStubRepositories() {
  const developerRepository: jest.Mocked<DeveloperRepository> = {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    upsertProfile: jest.fn(),
  };

  const apiRepository: jest.Mocked<ApiRepository> = {
    create: jest.fn(),
    createWithEndpoints: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    restore: jest.fn(),
    listByDeveloper: jest.fn(),
    listPublic: jest.fn(),
    findById: jest.fn(),
    findRawById: jest.fn(),
    getEndpoints: jest.fn(),
    bulkCreateEndpoints: jest.fn(),
  };

  const usageEventsRepository: jest.Mocked<UsageEventsRepository> = {
    findByDeveloper: jest.fn(),
    countByDeveloper: jest.fn(),
    findByUser: jest.fn(),
    developerOwnsApi: jest.fn(),
    aggregateByDeveloper: jest.fn(),
    aggregateByUser: jest.fn(),
    aggregateByHour: jest.fn(),
    getTopEndpoints: jest.fn(),
    sumSpendByConsumer: jest.fn(),
    listChargesByConsumer: jest.fn(),
  };

  return { developerRepository, apiRepository, usageEventsRepository };
}

function buildTestApp(
  developerRepository: DeveloperRepository,
  apiRepository: ApiRepository,
  usageEventsRepository: UsageEventsRepository,
) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  registerDeveloperAnalyticsRoutes(
    app,
    developerRepository,
    apiRepository,
    usageEventsRepository,
  );
  app.use(errorHandler);
  return app;
}

describe('registerDeveloperAnalyticsRoutes', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  let app: express.Express;
  let developerRepository: jest.Mocked<DeveloperRepository>;
  let apiRepository: jest.Mocked<ApiRepository>;
  let usageEventsRepository: jest.Mocked<UsageEventsRepository>;
  let authToken: string;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    authToken = signTestToken({ userId: USER_ID });
    const stubs = createStubRepositories();
    developerRepository = stubs.developerRepository;
    apiRepository = stubs.apiRepository;
    usageEventsRepository = stubs.usageEventsRepository;
    app = buildTestApp(developerRepository, apiRepository, usageEventsRepository);
  });

  afterEach(() => {
    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  describe('GET /api/developers/apis', () => {
    it('returns 401 when no auth token is provided', async () => {
      const res = await request(app).get('/api/developers/apis');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBeTruthy();
      expect(developerRepository.findByUserId).not.toHaveBeenCalled();
    });

    it('returns 404 when developer profile is not found', async () => {
      developerRepository.findByUserId.mockResolvedValue(undefined);

      const res = await request(app)
        .get('/api/developers/apis')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('Developer profile not found');
      expect(developerRepository.findByUserId).toHaveBeenCalledWith(USER_ID);
      expect(apiRepository.listByDeveloper).not.toHaveBeenCalled();
    });

    it('returns 400 when status query param is invalid', async () => {
      developerRepository.findByUserId.mockResolvedValue(sampleDeveloper);

      const res = await request(app)
        .get('/api/developers/apis?status=invalid_status')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toContain('status must be one of:');
      expect(apiRepository.listByDeveloper).not.toHaveBeenCalled();
    });

    it('uses default pagination and merges usage stats (callCount 0 and absent revenue when no usage row exists)', async () => {
      developerRepository.findByUserId.mockResolvedValue(sampleDeveloper);
      apiRepository.listByDeveloper.mockResolvedValue([
        sampleApiWithUsage,
        sampleApiWithoutUsage,
      ]);
      usageEventsRepository.aggregateByDeveloper.mockResolvedValue([
        { apiId: String(sampleApiWithUsage.id), calls: 42, revenue: 1500000n },
      ]);

      const res = await request(app)
        .get('/api/developers/apis')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.requestId).toBe('string');
      expect(apiRepository.listByDeveloper).toHaveBeenCalledWith(sampleDeveloper.id, {
        status: undefined,
        limit: 20,
        offset: 0,
      });
      expect(usageEventsRepository.aggregateByDeveloper).toHaveBeenCalledWith(USER_ID);
      expect(res.body.data).toEqual({
        data: [
          {
            id: 101,
            name: 'Weather API',
            status: 'active',
            callCount: 42,
            revenue: '1500000',
          },
          {
            id: 102,
            name: 'Draft API',
            status: 'draft',
            callCount: 0,
          },
        ],
        meta: { limit: 20, offset: 0 },
      });
      expect('revenue' in res.body.data.data[1]).toBe(false);
    });

    it('passes valid status filter and custom limit/offset to apiRepository', async () => {
      developerRepository.findByUserId.mockResolvedValue(sampleDeveloper);
      apiRepository.listByDeveloper.mockResolvedValue([sampleApiWithUsage]);
      usageEventsRepository.aggregateByDeveloper.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/developers/apis?status=active&limit=5&offset=10')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.requestId).toBe('string');
      expect(apiRepository.listByDeveloper).toHaveBeenCalledWith(sampleDeveloper.id, {
        status: 'active',
        limit: 5,
        offset: 10,
      });
      expect(res.body.data.meta).toEqual({ limit: 5, offset: 10 });
    });

    it('returns 400 when limit=0', async () => {
      developerRepository.findByUserId.mockResolvedValue(sampleDeveloper);

      const res = await request(app)
        .get('/api/developers/apis?limit=0')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBeTruthy();
      expect(apiRepository.listByDeveloper).not.toHaveBeenCalled();
    });

    it('clamps limit over the max of 100 to 100', async () => {
      developerRepository.findByUserId.mockResolvedValue(sampleDeveloper);
      apiRepository.listByDeveloper.mockResolvedValue([]);
      usageEventsRepository.aggregateByDeveloper.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/developers/apis?limit=500')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.requestId).toBe('string');
      expect(apiRepository.listByDeveloper).toHaveBeenCalledWith(sampleDeveloper.id, {
        status: undefined,
        limit: 100,
        offset: 0,
      });
      expect(res.body.data.meta).toEqual({ limit: 100, offset: 0 });
    });
  });

  describe('GET /api/developers/analytics', () => {
    it('returns 401 when no auth token is provided', async () => {
      const res = await request(app).get(
        '/api/developers/analytics?from=2026-01-01&to=2026-01-31',
      );

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBeTruthy();
    });

    it('returns 400 when groupBy is invalid', async () => {
      const res = await request(app)
        .get('/api/developers/analytics?groupBy=year&from=2026-01-01&to=2026-01-31')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('groupBy must be one of: day, week, month');
    });

    it('returns 400 when groupBy is passed twice (array in req.query)', async () => {
      const res = await request(app)
        .get('/api/developers/analytics?groupBy=day&groupBy=week&from=2026-01-01&to=2026-01-31')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('groupBy must be one of: day, week, month');
    });

    it('returns 400 when from or to is missing', async () => {
      const missingFrom = await request(app)
        .get('/api/developers/analytics?to=2026-01-31')
        .set('Authorization', `Bearer ${authToken}`);

      expect(missingFrom.status).toBe(400);
      expect(missingFrom.body.success).toBe(false);
      expect(typeof missingFrom.body.requestId).toBe('string');
      expect(missingFrom.body.error.code).toBe('BAD_REQUEST');
      expect(missingFrom.body.error.message).toBe('from and to are required ISO date values');

      const missingTo = await request(app)
        .get('/api/developers/analytics?from=2026-01-01')
        .set('Authorization', `Bearer ${authToken}`);

      expect(missingTo.status).toBe(400);
      expect(missingTo.body.success).toBe(false);
      expect(typeof missingTo.body.requestId).toBe('string');
      expect(missingTo.body.error.code).toBe('BAD_REQUEST');
      expect(missingTo.body.error.message).toBe('from and to are required ISO date values');
    });

    it('returns 400 when from is invalid (from=garbage)', async () => {
      const res = await request(app)
        .get('/api/developers/analytics?from=garbage&to=2026-01-31')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('from and to are required ISO date values');
    });

    it('returns 400 when from > to', async () => {
      const res = await request(app)
        .get('/api/developers/analytics?from=2026-02-01&to=2026-01-01')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('from must be before or equal to to');
    });

    it('allows from === to', async () => {
      usageEventsRepository.findByDeveloper.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/developers/analytics?from=2026-01-15T00:00:00.000Z&to=2026-01-15T00:00:00.000Z')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.data).toEqual({ data: [] });
      expect(usageEventsRepository.findByDeveloper).toHaveBeenCalledWith({
        developerId: USER_ID,
        from: new Date('2026-01-15T00:00:00.000Z'),
        to: new Date('2026-01-15T00:00:00.000Z'),
        apiId: undefined,
      });
    });

    it('returns 403 when apiId does not belong to authenticated developer', async () => {
      usageEventsRepository.developerOwnsApi.mockResolvedValue(false);

      const res = await request(app)
        .get('/api/developers/analytics?from=2026-01-01&to=2026-01-31&apiId=999')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe(
        'Forbidden: API does not belong to authenticated developer',
      );
      expect(usageEventsRepository.developerOwnsApi).toHaveBeenCalledWith(USER_ID, '999');
      expect(usageEventsRepository.findByDeveloper).not.toHaveBeenCalled();
    });

    it('returns analytics with topEndpoints and topUsers when includeTop=true', async () => {
      const events: UsageEvent[] = [
        {
          id: 'evt-1',
          developerId: USER_ID,
          apiId: '101',
          endpoint: '/v1/forecast',
          userId: 'consumer-1234',
          occurredAt: new Date('2026-01-10T12:00:00.000Z'),
          revenue: 500n,
        },
        {
          id: 'evt-2',
          developerId: USER_ID,
          apiId: '101',
          endpoint: '/v1/forecast',
          userId: 'consumer-1234',
          occurredAt: new Date('2026-01-10T15:00:00.000Z'),
          revenue: 700n,
        },
        {
          id: 'evt-3',
          developerId: USER_ID,
          apiId: '101',
          endpoint: '/v1/alerts',
          userId: 'consumer-5678',
          occurredAt: new Date('2026-01-11T09:00:00.000Z'),
          revenue: 300n,
        },
      ];

      usageEventsRepository.developerOwnsApi.mockResolvedValue(true);
      usageEventsRepository.findByDeveloper.mockResolvedValue(events);

      const res = await request(app)
        .get(
          '/api/developers/analytics?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z&groupBy=day&apiId=101&includeTop=true',
        )
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.requestId).toBe('string');
      expect(usageEventsRepository.developerOwnsApi).toHaveBeenCalledWith(USER_ID, '101');
      expect(usageEventsRepository.findByDeveloper).toHaveBeenCalledWith({
        developerId: USER_ID,
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-01-31T23:59:59.999Z'),
        apiId: '101',
      });
      expect(res.body.data).toEqual({
        data: [
          { period: '2026-01-10', calls: 2, revenue: '1200' },
          { period: '2026-01-11', calls: 1, revenue: '300' },
        ],
        topEndpoints: [
          { endpoint: '/v1/forecast', calls: 2 },
          { endpoint: '/v1/alerts', calls: 1 },
        ],
        topUsers: [
          { userId: 'user_1234', calls: 2 },
          { userId: 'user_5678', calls: 1 },
        ],
      });
    });
  });
});
