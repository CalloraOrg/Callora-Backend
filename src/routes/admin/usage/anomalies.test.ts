import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { createUsageAnomaliesRouter } from './anomalies.js';
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
  app.use('/api/admin/usage/anomalies', createUsageAnomaliesRouter({ pool: effectivePool as Pool | undefined }));
  app.use(errorHandler);
  return app;
}

const asResult = (rows: unknown[]): QueryResult =>
  ({ rows } as unknown as QueryResult);

const dayString = (index: number): string =>
  new Date(Date.UTC(2026, 2, 1 + index)).toISOString().slice(0, 10);

// Steady 10 calls/day over a 20-day baseline with a clear spike on the final
// day for api-1 (z-score comfortably above the default threshold of 3).
const SPIKE_ROWS = [
  ...Array.from({ length: 20 }, (_, i) => ({
    apiId: 'api-1',
    day: dayString(i),
    calls: 10,
    revenue: '0',
  })),
  { apiId: 'api-1', day: dayString(20), calls: 200, revenue: '5000' },
];
const SPIKE_DAY = dayString(20);

describe('GET /api/admin/usage/anomalies', () => {
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
      const res = await request(createTestApp()).get('/api/admin/usage/anomalies');
      expectErrorEnvelope(res, 401, 'UNAUTHORIZED');
    });

    it('returns 401 for a non-admin JWT', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(nonAdminHeaders());
      expectErrorEnvelope(res, 401, 'UNAUTHORIZED');
    });
  });

  it('returns detected anomalies with a summary', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data.anomalies).toHaveLength(1);
    expect(res.body.data.anomalies[0]).toMatchObject({
      apiId: 'api-1',
      day: SPIKE_DAY,
      type: 'spike',
      calls: 200,
      revenue: '5000',
    });
    expect(res.body.data.summary).toMatchObject({
      threshold: 3,
      minDataPoints: 3,
      seriesAnalyzed: 1,
      anomalyCount: 1,
    });
    expect(res.body.data.summary.window.from).toBeDefined();
    expect(res.body.data.summary.window.to).toBeDefined();
  });

  it('writes an audit log entry', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders());

    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USAGE_ANOMALIES',
      'admin-api-key',
      expect.objectContaining({ anomalyCount: 1, seriesAnalyzed: 1 }),
    );
  });

  it('returns an empty list when no anomalies are detected', async () => {
    mockQuery.mockResolvedValueOnce(asResult([
      { apiId: 'api-1', day: '2026-03-01', calls: 10, revenue: '0' },
      { apiId: 'api-1', day: '2026-03-02', calls: 10, revenue: '0' },
      { apiId: 'api-1', day: '2026-03-03', calls: 10, revenue: '0' },
    ]));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data.anomalies).toEqual([]);
    expect(res.body.data.summary.anomalyCount).toBe(0);
  });

  it('applies a custom threshold', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders())
      .query({ threshold: '10' });

    expect(res.status).toBe(200);
    // The spike's z-score (~2) is below a threshold of 10.
    expect(res.body.data.anomalies).toEqual([]);
    expect(res.body.data.summary.threshold).toBe(10);
  });

  it('passes an apiId filter through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders())
      .query({ apiId: 'api-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('AND api_id = $3');
    expect(params).toEqual([expect.any(Date), expect.any(Date), 'api-1']);
  });

  it('passes the date window through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders())
      .query({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' });

    const [, params] = mockQuery.mock.calls[0];
    expect((params[0] as Date).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect((params[1] as Date).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  describe('input validation', () => {
    it('returns 400 for an invalid "from" date', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ from: 'nope' });
      expectValidationError(res, 'query.from', 'ISO-8601');
    });

    it('returns 400 when "from" is supplied as multiple values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies?from=2026-01-01&from=2026-02-01')
        .set(adminHeaders());
      expectValidationError(res, 'query.from');
    });

    it('returns 400 when threshold is supplied as multiple values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies?threshold=3&threshold=4')
        .set(adminHeaders());
      expectValidationError(res, 'query.threshold');
    });

    it('returns 400 for an invalid "to" date', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ to: 'nope' });
      expectValidationError(res, 'query.to', 'ISO-8601');
    });

    it('returns 400 when from is after to', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ from: '2026-03-31T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
      expectErrorEnvelope(res, 400, 'BAD_REQUEST', 'from must be before or equal to to');
    });

    it('returns 400 for an out-of-range threshold', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ threshold: '99' });
      expectValidationError(res, 'query.threshold', 'threshold must be a number between 1 and 10');
    });

    it('returns 400 for a non-numeric threshold', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ threshold: 'abc' });
      expectValidationError(res, 'query.threshold', 'threshold must be a number between 1 and 10');
    });

    it('returns 400 for a non-integer limit', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ limit: '1.5' });
      expectValidationError(res, 'query.limit', 'limit must be an integer between 1 and 1000');
    });

    it('returns 400 for an out-of-range limit', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies')
        .set(adminHeaders())
        .query({ limit: '0' });
      expectValidationError(res, 'query.limit', 'limit must be an integer between 1 and 1000');
    });

    it('returns 400 when apiId is supplied as multiple values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/anomalies?apiId=a&apiId=b')
        .set(adminHeaders());
      expectValidationError(res, 'query.apiId');
    });
  });

  it('returns 500 when the database pool is unavailable', async () => {
    const app = createTestApp({ noPool: true });
    const res = await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders());
    expectErrorEnvelope(res, 500, 'INTERNAL_SERVER_ERROR');
  });

  it('returns 500 when the aggregation query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const app = createTestApp();
    const res = await request(app)
      .get('/api/admin/usage/anomalies')
      .set(adminHeaders());
    expectErrorEnvelope(res, 500, 'INTERNAL_SERVER_ERROR');
    expect(logger.error).toHaveBeenCalled();
  });
});
