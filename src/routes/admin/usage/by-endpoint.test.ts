import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { createAdminUsageByEndpointRouter } from './by-endpoint.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../../middleware/requestId.js';
import {
  adminHeaders,
  expectErrorEnvelope,
  expectValidationError,
  nonAdminHeaders,
  restoreAdminAuthEnv,
  setupAdminAuthEnv,
  type SavedAuthEnv,
} from './testHelpers.js';

jest.mock('../../../middleware/ipAllowlist', () => ({
  createAdminIpAllowlist: jest.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
}));

jest.mock('../../../logger', () => {
  const actual = jest.requireActual('../../../logger');
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

import { logger } from '../../../logger.js';

const mockQuery = jest.fn();
const mockPool = { query: mockQuery } as unknown as Pool;

function createTestApp(deps: { pool?: Pool; noPool?: boolean } = {}): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  const effectivePool = deps.noPool ? undefined : (deps.pool ?? mockPool);
  app.use('/api/admin/usage/by-endpoint', createAdminUsageByEndpointRouter({ pool: effectivePool as Pool | undefined }));
  app.use(errorHandler);
  return app;
}

const asResult = (rows: unknown[]): QueryResult =>
  ({ rows } as unknown as QueryResult);

const ENDPOINT_ROWS = [
  { endpoint: '/v1/search', calls: 150, revenue: '15000' },
  { endpoint: '/v1/weather', calls: 80, revenue: '8000' },
  { endpoint: '/v1/forecast', calls: 30, revenue: '3000' },
];

describe('GET /api/admin/usage/by-endpoint', () => {
  let savedAuthEnv: SavedAuthEnv;

  beforeAll(() => {
    savedAuthEnv = setupAdminAuthEnv();
  });

  afterAll(() => {
    restoreAdminAuthEnv(savedAuthEnv);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('authentication', () => {
    it('returns 401 when no admin credentials are provided', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/by-endpoint');
      expectErrorEnvelope(res, 401, 'UNAUTHORIZED');
    });

    it('returns 401 for a non-admin JWT', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(nonAdminHeaders());
      expectErrorEnvelope(res, 401, 'UNAUTHORIZED');
    });
  });

  it('returns top endpoints aggregated across all developers', async () => {
    mockQuery.mockResolvedValueOnce(asResult(ENDPOINT_ROWS));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { endpoint: '/v1/search', calls: 150, revenue: '15000' },
      { endpoint: '/v1/weather', calls: 80, revenue: '8000' },
      { endpoint: '/v1/forecast', calls: 30, revenue: '3000' },
    ]);
    expect(res.body.period).toBeDefined();
    expect(res.body.period.from).toBeDefined();
    expect(res.body.period.to).toBeDefined();
  });

  it('writes an audit log entry', async () => {
    mockQuery.mockResolvedValueOnce(asResult(ENDPOINT_ROWS));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders());

    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USAGE_BY_ENDPOINT',
      'admin-api-key',
      expect.objectContaining({ endpointCount: 3 }),
    );
  });

  it('returns an empty list when no usage events exist', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('passes apiId filter through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders())
      .query({ apiId: 'api-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('api_id = $3');
    expect(params).toContain('api-1');
  });

  it('passes developerId filter through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders())
      .query({ developerId: 'dev-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('developer_id = $3');
    expect(params).toContain('dev-1');
  });

  it('passes both apiId and developerId filters', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders())
      .query({ apiId: 'api-1', developerId: 'dev-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('api_id = $3');
    expect(sql).toContain('developer_id = $4');
    expect(params).toEqual([expect.any(Date), expect.any(Date), 'api-1', 'dev-1', 10]);
  });

  it('passes the date window through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders())
      .query({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' });

    const [, params] = mockQuery.mock.calls[0];
    expect((params[0] as Date).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect((params[1] as Date).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('passes a custom limit through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders())
      .query({ limit: '25' });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[params.length - 1]).toBe(25);
  });

  describe('input validation', () => {
    it('returns 400 for an invalid "from" date', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ from: 'nope' });
      expectValidationError(res, 'query.from', 'ISO-8601');
    });

    it('returns 400 when "from" is supplied as multiple values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint?from=2026-01-01&from=2026-02-01')
        .set(adminHeaders());
      expectValidationError(res, 'query.from');
    });

    it('returns 400 for an invalid "to" date', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ to: 'nope' });
      expectValidationError(res, 'query.to', 'ISO-8601');
    });

    it('returns 400 when from is after to', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ from: '2026-03-31T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
      expectErrorEnvelope(res, 400, 'BAD_REQUEST', 'from must be before or equal to to');
    });

    it('returns 400 for a non-numeric limit', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ limit: 'abc' });
      expectValidationError(res, 'query.limit', 'limit must be an integer between 1 and 1000');
    });

    it('returns 400 for a non-integer limit', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ limit: '1.5' });
      expectValidationError(res, 'query.limit', 'limit must be an integer between 1 and 1000');
    });

    it('returns 400 for an out-of-range limit (zero)', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ limit: '0' });
      expectValidationError(res, 'query.limit', 'limit must be an integer between 1 and 1000');
    });

    it('returns 400 for an out-of-range limit (exceeds max)', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint')
        .set(adminHeaders())
        .query({ limit: '1001' });
      expectValidationError(res, 'query.limit', 'limit must be an integer between 1 and 1000');
    });

    it('returns 400 when apiId is supplied as multiple values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint?apiId=a&apiId=b')
        .set(adminHeaders());
      expectValidationError(res, 'query.apiId');
    });

    it('returns 400 when developerId is supplied as multiple values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/by-endpoint?developerId=a&developerId=b')
        .set(adminHeaders());
      expectValidationError(res, 'query.developerId');
    });
  });

  it('returns 500 when the database pool is unavailable', async () => {
    const app = createTestApp({ noPool: true });
    const res = await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders());
    expectErrorEnvelope(res, 500, 'INTERNAL_SERVER_ERROR');
  });

  it('returns 500 when the aggregation query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const app = createTestApp();
    const res = await request(app)
      .get('/api/admin/usage/by-endpoint')
      .set(adminHeaders());
    expectErrorEnvelope(res, 500, 'INTERNAL_SERVER_ERROR');
    expect(logger.error).toHaveBeenCalled();
  });
});
