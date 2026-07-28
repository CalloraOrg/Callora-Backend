import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { createSpikeRouter } from './spike.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../../middleware/requestId.js';

jest.mock('../../../middleware/adminAuth', () => ({
  adminAuth: jest.fn((_req: Request, _res: Response, next: NextFunction) => {
    _res.locals = { ..._res.locals, adminActor: 'test-admin' };
    next();
  }),
}));

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
  app.use('/api/admin/usage/spike', createSpikeRouter({ pool: effectivePool as Pool | undefined }));
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

describe('GET /api/admin/usage/spike', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('returns detected spikes with a summary', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    const res = await request(app).get('/api/admin/usage/spike');

    expect(res.status).toBe(200);
    expect(res.body.data.spikes).toHaveLength(1);
    expect(res.body.data.spikes[0]).toMatchObject({
      apiId: 'api-1',
      day: SPIKE_DAY,
      calls: 200,
      revenue: '5000',
    });
    expect(res.body.data.summary).toMatchObject({
      threshold: 3,
      minDataPoints: 3,
      seriesAnalyzed: 1,
      spikeCount: 1,
    });
    expect(res.body.data.summary.window.from).toBeDefined();
    expect(res.body.data.summary.window.to).toBeDefined();
  });

  it('includes percentageChange in the spike data', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    const res = await request(app).get('/api/admin/usage/spike');

    expect(res.body.data.spikes[0].percentageChange).toBeGreaterThan(900);
  });

  it('writes an audit log entry', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    await request(app).get('/api/admin/usage/spike');

    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USAGE_SPIKES',
      'test-admin',
      expect.objectContaining({ spikeCount: 1, seriesAnalyzed: 1 }),
    );
  });

  it('returns an empty list when no spikes are detected', async () => {
    mockQuery.mockResolvedValueOnce(asResult([
      { apiId: 'api-1', day: '2026-03-01', calls: 10, revenue: '0' },
      { apiId: 'api-1', day: '2026-03-02', calls: 10, revenue: '0' },
      { apiId: 'api-1', day: '2026-03-03', calls: 10, revenue: '0' },
    ]));
    const app = createTestApp();

    const res = await request(app).get('/api/admin/usage/spike');

    expect(res.status).toBe(200);
    expect(res.body.data.spikes).toEqual([]);
    expect(res.body.data.summary.spikeCount).toBe(0);
  });

  it('applies a custom threshold', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    const res = await request(app).get('/api/admin/usage/spike').query({ threshold: '10' });

    expect(res.status).toBe(200);
    // The spike's z-score (~2) is below a threshold of 10.
    expect(res.body.data.spikes).toEqual([]);
    expect(res.body.data.summary.threshold).toBe(10);
  });

  it('passes an apiId filter through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult(SPIKE_ROWS));
    const app = createTestApp();

    await request(app).get('/api/admin/usage/spike').query({ apiId: 'api-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('AND api_id = $3');
    expect(params).toEqual([expect.any(Date), expect.any(Date), 'api-1']);
  });

  it('passes the date window through to the query', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/spike')
      .query({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' });

    const [, params] = mockQuery.mock.calls[0];
    expect((params[0] as Date).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect((params[1] as Date).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  describe('input validation', () => {
    it('returns 400 for an invalid "from" date', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike').query({ from: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when "from" is supplied as multiple values', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike?from=2026-01-01&from=2026-02-01');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for an invalid "to" date', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike').query({ to: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when from is after to', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/spike')
        .query({ from: '2026-03-31T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('from must be before or equal to to');
    });

    it('returns 400 for an out-of-range threshold', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike').query({ threshold: '99' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for a non-numeric threshold', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike').query({ threshold: 'abc' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for a non-integer limit', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike').query({ limit: '1.5' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for an out-of-range limit', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike').query({ limit: '0' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when apiId is supplied as multiple values', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/spike?apiId=a&apiId=b');
      expect(res.status).toBe(400);
    });
  });

  it('returns 500 when the database pool is unavailable', async () => {
    const app = createTestApp({ noPool: true });
    const res = await request(app).get('/api/admin/usage/spike');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('returns 500 when the aggregation query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const app = createTestApp();
    const res = await request(app).get('/api/admin/usage/spike');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(logger.error).toHaveBeenCalled();
  });
});
