import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../../src/routes/admin.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createUsageStore } from '../../src/services/usageStore.js';
import { logger } from '../../src/logger.js';

jest.mock('../../src/logger', () => {
  const actual = jest.requireActual('../../src/logger');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      audit: jest.fn(),
    },
  };
});

jest.mock('../../src/repositories/userRepository', () => ({
  findUsers: jest.fn().mockResolvedValue({ users: [], total: 0 }),
}));

const TEST_ADMIN_API_KEY = 'test-admin-api-key';
const originalAdminApiKey = process.env.ADMIN_API_KEY;
const originalIpRanges = process.env.ADMIN_IP_ALLOWED_RANGES;
const originalIpAllowlistEnabled = process.env.ADMIN_IP_ALLOWLIST_ENABLED;

const buildApp = (usageStore = createUsageStore()) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ usageStore }));
  app.use(errorHandler);
  return { app, usageStore };
};

const seedUsage = (usageStore: ReturnType<typeof createUsageStore>) => {
  usageStore.record({
    id: 'evt_1',
    requestId: 'req_1',
    apiKey: 'secret-api-key',
    apiKeyId: 'key_1',
    apiId: 'api_1',
    endpointId: 'endpoint_1',
    userId: 'dev_001',
    amountUsdc: 1.5,
    statusCode: 200,
    timestamp: '2026-06-25T10:00:00.000Z',
  });
  usageStore.record({
    id: 'evt_2',
    requestId: 'req_2',
    apiKey: 'another-secret-api-key',
    apiKeyId: 'key_2',
    apiId: 'api_2',
    endpointId: 'endpoint_2',
    userId: 'dev_001',
    amountUsdc: 2,
    statusCode: 500,
    timestamp: '2026-06-25T10:05:00.000Z',
    settlementId: 'stl_1',
  });
};

describe('admin usage inspection and reset endpoints', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    delete process.env.ADMIN_IP_ALLOWED_RANGES;
    delete process.env.ADMIN_IP_ALLOWLIST_ENABLED;
  });

  afterEach(() => {
    if (originalAdminApiKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    }

    if (originalIpRanges === undefined) {
      delete process.env.ADMIN_IP_ALLOWED_RANGES;
    } else {
      process.env.ADMIN_IP_ALLOWED_RANGES = originalIpRanges;
    }

    if (originalIpAllowlistEnabled === undefined) {
      delete process.env.ADMIN_IP_ALLOWLIST_ENABLED;
    } else {
      process.env.ADMIN_IP_ALLOWLIST_ENABLED = originalIpAllowlistEnabled;
    }

    jest.clearAllMocks();
  });

  it('rejects usage reads without admin credentials', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/admin/usage/dev_001');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('applies the admin IP allowlist before usage reads', async () => {
    process.env.ADMIN_IP_ALLOWED_RANGES = '203.0.113.0/24';
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/admin/usage/dev_001')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IP_NOT_ALLOWED');
  });

  it('returns 404 for unknown developer usage aggregates', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/admin/usage/missing_dev')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USAGE_AGGREGATE_NOT_FOUND');
  });

  it('returns a redacted current usage aggregate snapshot', async () => {
    const { app, usageStore } = buildApp();
    seedUsage(usageStore);

    const res = await request(app)
      .get('/api/admin/usage/dev_001')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      developerId: 'dev_001',
      totalEvents: 2,
      settledEvents: 1,
      unsettledEvents: 1,
      totalAmountUsdc: 3.5,
      settledAmountUsdc: 2,
      unsettledAmountUsdc: 1.5,
      apiCount: 2,
      endpointCount: 2,
      firstEventAt: '2026-06-25T10:00:00.000Z',
      lastEventAt: '2026-06-25T10:05:00.000Z',
      statusCodes: { '200': 1, '500': 1 },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret-api-key');
    expect(logger.audit).toHaveBeenCalledWith(
      'READ_USAGE_AGGREGATE',
      'admin-api-key',
      expect.objectContaining({ developerId: 'dev_001', totalEvents: 2 }),
    );
  });

  it('resets usage and audits prior aggregate values', async () => {
    const { app, usageStore } = buildApp();
    seedUsage(usageStore);

    const resetRes = await request(app)
      .post('/api/admin/usage/dev_001/reset')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(resetRes.status).toBe(200);
    expect(resetRes.body.data.reset).toBe(true);
    expect(resetRes.body.data.priorValues).toEqual(expect.objectContaining({
      developerId: 'dev_001',
      totalEvents: 2,
      totalAmountUsdc: 3.5,
    }));
    expect(logger.audit).toHaveBeenCalledWith(
      'RESET_USAGE_AGGREGATE',
      'admin-api-key',
      expect.objectContaining({
        developerId: 'dev_001',
        priorValues: expect.objectContaining({ totalEvents: 2 }),
      }),
    );

    const readAfterReset = await request(app)
      .get('/api/admin/usage/dev_001')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(readAfterReset.status).toBe(404);
    expect(usageStore.getEvents()).toHaveLength(0);
  });

  it('rejects usage resets without admin credentials', async () => {
    const { app } = buildApp();

    const res = await request(app).post('/api/admin/usage/dev_001/reset');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
