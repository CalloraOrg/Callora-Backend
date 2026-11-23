import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import adminRouter from '../../admin.js';
import { createAdminUsageExportRouter } from './export.js';
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

const mockQuery = jest.fn();
const mockPool = { query: mockQuery } as unknown as Pool;

jest.mock('../../../db/index.js', () => ({
  db: {},
  sqlite: {
    transaction: jest.fn(() => jest.fn()),
    prepare: jest.fn(() => ({ get: jest.fn(), run: jest.fn(), all: jest.fn() })),
  },
  schema: jest.requireActual('../../../db/schema.js'),
}));

jest.mock('../../../db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
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
      const res = await request(createTestApp()).get('/api/admin/usage/export');
      expectErrorEnvelope(res, 401, 'UNAUTHORIZED');
    });

    it('returns 401 for a non-admin JWT', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export')
        .set(nonAdminHeaders());
      expectErrorEnvelope(res, 401, 'UNAUTHORIZED');
    });
  });

  it('streams CSV export with correct headers', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders());

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

    const res = await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
  });

  it('streams JSON export when format=json', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    const res = await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders())
      .query({ format: 'json' });

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

    await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders())
      .query({ developerId: 'dev-1' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('developer_id');
    expect(params[2]).toBe('dev-1');
  });

  it('applies apiId filter', async () => {
    mockQuery.mockResolvedValueOnce(asResult(MOCK_ROWS));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders())
      .query({ apiId: 'api-1' });

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('api_id');
  });

  it('applies date window filter', async () => {
    mockQuery.mockResolvedValueOnce(asResult([]));
    const app = createTestApp();

    await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders())
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
    const res = await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(res.text).toContain('req-501');
  });

  describe('input validation', () => {
    it('returns 400 for an invalid "from" date', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export')
        .set(adminHeaders())
        .query({ from: 'nope' });
      expectValidationError(res, 'query.from', 'ISO-8601');
    });

    it('returns 400 for an invalid "to" date', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export')
        .set(adminHeaders())
        .query({ to: 'nope' });
      expectValidationError(res, 'query.to', 'ISO-8601');
    });

    it('returns 400 when from is after to', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export')
        .set(adminHeaders())
        .query({ from: '2026-03-31T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
      expectErrorEnvelope(res, 400, 'BAD_REQUEST', 'from must be before or equal to to');
    });

    it('returns 400 for multiple developerId values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export?developerId=a&developerId=b')
        .set(adminHeaders());
      expectValidationError(res, 'query.developerId');
    });

    it('returns 400 for multiple apiId values', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export?apiId=a&apiId=b')
        .set(adminHeaders());
      expectValidationError(res, 'query.apiId');
    });

    it('returns 400 for an unsupported format', async () => {
      const res = await request(createTestApp())
        .get('/api/admin/usage/export')
        .set(adminHeaders())
        .query({ format: 'xml' });
      expectValidationError(res, 'query.format');
    });
  });

  it('returns 500 when database pool is unavailable', async () => {
    const app = createTestApp({ noPool: true });
    const res = await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders());
    expectErrorEnvelope(res, 500, 'INTERNAL_SERVER_ERROR');
  });

  it('returns 500 when query fails before headers', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const app = createTestApp();
    const res = await request(app)
      .get('/api/admin/usage/export')
      .set(adminHeaders());
    expectErrorEnvelope(res, 500, 'INTERNAL_SERVER_ERROR');
  });
});
