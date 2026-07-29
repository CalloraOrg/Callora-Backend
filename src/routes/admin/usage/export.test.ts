import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import adminRouter from '../../admin.js';
import { createAdminUsageExportRouter } from './export.js';
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

const mockQuery = jest.fn();
const mockPool = { query: mockQuery } as unknown as Pool;

function createTestApp(deps: { pool?: Pool; noPool?: boolean } = {}): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  const effectivePool = deps.noPool ? undefined : (deps.pool ?? mockPool);
  app.use('/api/admin/usage/export', createAdminUsageExportRouter({ pool: effectivePool as Pool | undefined }));
  app.use(errorHandler);
  return app;
}

const asResult = (rows: unknown[]): QueryResult =>
  ({ rows } as unknown as QueryResult);

const MOCK_ROWS = [
  {
    id: '1',
    developerId: 'dev-1',
    apiId: 'api-1',
    endpointId: 'ep-1',
    userId: 'user-1',
    amount: '100',
    requestId: 'req-1',
    createdAt: '2026-03-01T12:00:00Z',
  },
  {
    id: '2',
    developerId: 'dev-1',
    apiId: 'api-1',
    endpointId: 'ep-1',
    userId: 'user-2',
    amount: '200',
    requestId: 'req-2',
    createdAt: '2026-03-02T12:00:00Z',
  },
];

describe('GET /api/admin/usage/export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('streams CSV export with correct headers', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    const res = await request(app).get('/api/admin/usage/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.text).toContain('id,developerId,apiId,endpoint,userId,amount,requestId,createdAt');
    expect(res.text).toContain('req-1');
    expect(res.text).toContain('req-2');
  });

  it('is mounted on /api/admin/usage/export from the parent admin router', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/admin', adminRouter);
    app.use(errorHandler);

    const res = await request(app).get('/api/admin/usage/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
  });

  it('streams JSON export when format=json', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    const res = await request(app).get('/api/admin/usage/export').query({ format: 'json' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const parsed = JSON.parse(res.text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].requestId).toBe('req-1');
    expect(parsed[1].requestId).toBe('req-2');
  });

  it('applies developerId filter', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    await request(app).get('/api/admin/usage/export').query({ developerId: 'dev-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('developer_id');
    expect(params[2]).toBe('dev-1');
  });

  it('applies apiId filter', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    await request(app).get('/api/admin/usage/export').query({ apiId: 'api-1' });

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('api_id');
  });

  it('applies date window filter', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/export')
      .query({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' });

    const [, params] = mockQuery.mock.calls[0];
    expect((params[0] as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((params[1] as Date).toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('paginates through multiple batches', async () => {
    const manyRows = Array.from({ length: 501 }, (_, i) => ({
      id: String(i + 1),
      developerId: 'dev-1',
      apiId: 'api-1',
      endpointId: 'ep-1',
      userId: 'user-1',
      amount: '100',
      requestId: 'req-' + (i + 1),
      createdAt: '2026-03-01T12:00:00Z',
    }));
    mockQuery.mockResolvedValueOnce(asResult(manyRows.slice(0, 500)));
    mockQuery.mockResolvedValueOnce(asResult(manyRows.slice(500, 501)));

    const app = createTestApp();
    const res = await request(app).get('/api/admin/usage/export');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(res.text).toContain('req-501');
  });

  describe('input validation', () => {
    it('returns 400 for an invalid "from" date', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/export').query({ from: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('returns 400 for an invalid "to" date', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/export').query({ to: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('returns 400 when from is after to', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export')
        .query({ from: '2026-03-31T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('from must be before or equal to to');
    });

    it('returns 400 for multiple developerId values', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/export?developerId=a&developerId=b');
      expect(res.status).toBe(400);
    });

    it('returns 400 for multiple apiId values', async () => {
      const res = await request(createTestApp()).get('/api/admin/usage/export?apiId=a&apiId=b');
      expect(res.status).toBe(400);
    });
  });

  it('returns 500 when database pool is unavailable', async () => {
    const app = createTestApp({ noPool: true });
    const res = await request(app).get('/api/admin/usage/export');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('returns 500 when query fails before headers', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const app = createTestApp();
    const res = await request(app).get('/api/admin/usage/export');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
