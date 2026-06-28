import express from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { createExplainRouter } from './explain.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { logger } from '../../logger.js';

jest.mock('../../middleware/adminAuth', () => ({
  adminAuth: jest.fn((_req: any, _res: any, next: any) => {
    _res.locals = { ..._res.locals, adminActor: 'test-admin' };
    next();
  }),
}));

jest.mock('../../middleware/ipAllowlist', () => ({
  createAdminIpAllowlist: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../logger', () => {
  const actual = jest.requireActual('../../logger');
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
  app.use(express.json());
  app.use(requestIdMiddleware);
  const effectivePool = deps.noPool ? undefined : (deps.pool ?? mockPool);
  app.use('/api/admin/db/explain', createExplainRouter({ pool: effectivePool as Pool | undefined }));
  app.use(errorHandler);
  return app;
}

const SAMPLE_PLAN = [
  {
    Plan: {
      NodeType: 'Seq Scan',
      RelationName: 'users',
      Alias: 'users',
      StartupCost: 0,
      TotalCost: 10,
      PlanRows: 100,
      PlanWidth: 50,
      ActualStartupTime: 0.01,
      ActualTotalTime: 0.5,
      ActualRows: 100,
      ActualLoops: 1,
    },
    PlanningTime: 0.1,
    ExecutionTime: 0.5,
  },
];

function makeExplainRow(plan: unknown): Record<string, unknown> {
  return { 'QUERY PLAN': JSON.stringify(plan) };
}

describe('POST /api/admin/db/explain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('input validation', () => {
    it('returns 400 when request body is empty', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/admin/db/explain').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('returns 400 when query is an empty string', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: '' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('returns 400 when params is not an array', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1', params: 'invalid' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('accepts request without params (defaults to [])', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });
      expect(res.status).toBe(200);
    });

    it('returns 400 when query exceeds max length', async () => {
      const app = createTestApp();
      const longQuery = 'SELECT 1 ' + 'x'.repeat(50_000);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: longQuery });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });
  });

  describe('allowlist enforcement', () => {
    const forbiddenQueries = [
      ['INSERT INTO users (id) VALUES (1)', 'INSERT'],
      ['UPDATE users SET name = \'x\' WHERE id = 1', 'UPDATE'],
      ['DELETE FROM users WHERE id = 1', 'DELETE'],
      ['DROP TABLE users', 'DROP'],
      ['ALTER TABLE users ADD COLUMN x INT', 'ALTER'],
      ['CREATE TABLE tmp (id INT)', 'CREATE'],
      ['TRUNCATE users', 'TRUNCATE'],
      ['REINDEX TABLE users', 'REINDEX'],
      ['SELECT 1; DROP TABLE users', 'multi-statement with SELECT prefix'],
    ];

    it.each(forbiddenQueries)('rejects %s', async (query) => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('not allowed');
    });

    it('allows SELECT query', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users WHERE id = $1', params: [1] });
      expect(res.status).toBe(200);
    });

    it('allows WITH (CTE) query', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'WITH t AS (SELECT 1) SELECT * FROM t' });
      expect(res.status).toBe(200);
    });

    it('rejects multi-statement query with DML after SELECT', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1; DELETE FROM users' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('not allowed');
    });

    it('allows SELECT with semicolon inside string literal', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: "SELECT 'hello; world'" });
      expect(res.status).toBe(200);
    });

    it('rejects multi-statement with semicolons in comments', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1 -- harmless; comment\n; DROP TABLE users' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('not allowed');
    });
  });

  describe('successful execution', () => {
    it('returns the query plan as structured JSON when QUERY PLAN column is present', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users WHERE id = $1', params: [42] });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('plan');
      expect(JSON.parse(res.body.plan as string)).toEqual(SAMPLE_PLAN);
    });

    it('returns raw rows when QUERY PLAN column is absent', async () => {
      const app = createTestApp();
      const rawRows = [{ id: 1, name: 'test' }];
      mockQuery.mockResolvedValueOnce({ rows: rawRows } as unknown as QueryResult);
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT id, name FROM users LIMIT 1' });

      expect(res.status).toBe(200);
      expect(res.body.plan).toEqual(rawRows);
    });

    it('passes parameters to the database query', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users WHERE id = $1 AND status = $2', params: [1, 'active'] });

      expect(mockQuery).toHaveBeenCalledWith(
        'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM users WHERE id = $1 AND status = $2',
        [1, 'active'],
      );
    });
  });

  describe('audit logging', () => {
    it('logs an audit event on successful explain', async () => {
      const app = createTestApp();
      mockQuery.mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);
      await request(app)
        .post('/api/admin/db/explain')
        .set('User-Agent', 'test-agent')
        .send({ query: 'SELECT COUNT(*) FROM usage_events', params: [] });

      expect(logger.audit).toHaveBeenCalledWith(
        'DB_EXPLAIN',
        'test-admin',
        expect.objectContaining({
          clientIp: expect.any(String),
          userAgent: 'test-agent',
          query: 'SELECT COUNT(*) FROM usage_events',
          paramCount: 0,
        }),
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when pool is not available', async () => {
      const app = createTestApp({ noPool: true });
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });
      expect(res.status).toBe(500);
      expect(res.body.message).toContain('Database pool not available');
    });

    it('returns 400 when the database query fails', async () => {
      const app = createTestApp();
      mockQuery.mockRejectedValueOnce(new Error('relation "does_not_exist" does not exist'));
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM does_not_exist' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('does not exist');
    });

    it('returns 400 for generic DB error', async () => {
      const app = createTestApp();
      mockQuery.mockRejectedValueOnce('string error');
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('EXPLAIN query execution failed');
    });

    it('recovers after a failed query for subsequent successful queries', async () => {
      const app = createTestApp();
      mockQuery
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValueOnce({ rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult);

      const failRes = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });
      expect(failRes.status).toBe(400);

      const successRes = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });
      expect(successRes.status).toBe(200);
      expect(successRes.body).toHaveProperty('plan');
    });
  });
});

describe('createExplainRouter', () => {
  it('returns a Router instance', () => {
    const router = createExplainRouter();
    expect(router).toBeDefined();
    expect(typeof router.use).toBe('function');
    expect(typeof router.post).toBe('function');
  });
});
