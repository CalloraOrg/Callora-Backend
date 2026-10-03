import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createExplainRouter } from './explain.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { logger } from '../../logger.js';
import type { ReplicaPool } from '../../db/replicaPool.js';

jest.mock('../../middleware/adminAuth', () => ({
  adminAuth: jest.fn((_req: Request, _res: Response, next: NextFunction) => {
    _res.locals = { ..._res.locals, adminActor: 'test-admin' };
    next();
  }),
}));

jest.mock('../../middleware/ipAllowlist', () => ({
  createAdminIpAllowlist: jest.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
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
const mockRelease = jest.fn();
const mockConnect = jest.fn();

const mockClient = {
  query: mockQuery,
  release: mockRelease,
} as unknown as PoolClient;

const mockPool = {
  connect: mockConnect,
  query: mockQuery,
} as unknown as Pool;

function errorEnvelopeCompat(req: Request, res: Response, next: NextFunction): void {
  const origJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    if (
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as Record<string, unknown>).error === 'object'
    ) {
      const err = (body as { error: { code?: string; message?: string } }).error;
      const b = body as Record<string, unknown>;
      b.message = b.message ?? err.message;
      b.code = b.code ?? err.code;
    }
    return origJson(body);
  };
  next();
}

function createTestApp(
  deps: {
    pool?: Pool;
    replicaPool?: ReplicaPool;
    noPool?: boolean;
    statementTimeoutMs?: number;
  } = {},
): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(errorEnvelopeCompat);
  app.use(express.json());
  const effectivePool = deps.noPool ? undefined : (deps.pool ?? mockPool);
  app.use(
    '/api/admin/db/explain',
    createExplainRouter({
      pool: effectivePool as Pool | undefined,
      replicaPool: deps.replicaPool,
      statementTimeoutMs: deps.statementTimeoutMs,
    }),
  );
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
    mockRelease.mockReset();
    mockConnect.mockReset();
    mockConnect.mockResolvedValue(mockClient);

    // Default mock behavior: transaction statements resolve, EXPLAIN returns SAMPLE_PLAN
    mockQuery.mockImplementation(async (sql: string) => {
      if (
        sql === 'BEGIN READ ONLY' ||
        sql.startsWith('SET LOCAL statement_timeout') ||
        sql === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      return { rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult;
    });
  });

  describe('input validation', () => {
    it('returns 400 when request body is empty', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/admin/db/explain').send({});
      expect(res.status).toBe(400);
      expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(res.body.code);
    });

    it('returns 400 when query is an empty string', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: '' });
      expect(res.status).toBe(400);
      expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(res.body.code);
    });

    it('returns 400 when params is not an array', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1', params: 'invalid' });
      expect(res.status).toBe(400);
      expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(res.body.code);
    });

    it('accepts request without params (defaults to [])', async () => {
      const app = createTestApp();
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
      expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(res.body.code);
    });
  });

  describe('allowlist and DML keyword enforcement', () => {
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
      ['WITH d AS (DELETE FROM users RETURNING 1) SELECT * FROM d', 'CTE with DELETE'],
      ['WITH u AS (UPDATE users SET name = \'x\') SELECT * FROM u', 'CTE with UPDATE'],
      ['WITH i AS (INSERT INTO users (id) VALUES (1) RETURNING id) SELECT * FROM i', 'CTE with INSERT'],
      ['WITH dropped AS (DROP TABLE users) SELECT 1', 'CTE with DROP'],
      ['WITH truncated AS (TRUNCATE users) SELECT 1', 'CTE with TRUNCATE'],
      ['WITH altered AS (ALTER TABLE users DROP COLUMN x) SELECT 1', 'CTE with ALTER'],
      ['WITH merged AS (MERGE INTO users USING o ON 1=1 WHEN MATCHED THEN DELETE) SELECT 1', 'CTE with MERGE'],
    ];

    it.each(forbiddenQueries)('rejects %s', async (query) => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('not allowed');
      // Must reject before database execution — client connect should never be called
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('allows SELECT query', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users WHERE id = $1', params: [1] });
      expect(res.status).toBe(200);
    });

    it('allows read-only WITH (CTE) query', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'WITH t AS (SELECT 1 AS val) SELECT * FROM t' });
      expect(res.status).toBe(200);
    });

    it('allows query containing keywords inside string literals', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: "SELECT * FROM audit_logs WHERE action = 'DELETE'" });
      expect(res.status).toBe(200);
    });

    it('allows query containing keywords inside dollar-quoted strings', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM audit_logs WHERE action = $$DELETE$$' });
      expect(res.status).toBe(200);
    });

    it('allows query containing keywords in comments', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1 -- this was run after DELETE\n/* UPDATE note */' });
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

  describe('successful execution and dedicated client lifecycle', () => {
    it('executes inside BEGIN READ ONLY, sets statement_timeout, and rolls back', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users WHERE id = $1', params: [42] });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('plan');
      expect(JSON.parse(res.body.plan as string)).toEqual(SAMPLE_PLAN);

      // Verify transaction sequence on the dedicated client
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(1, 'BEGIN READ ONLY');
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/^SET LOCAL statement_timeout = \d+/),
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM users WHERE id = $1',
        [42],
      );
      expect(mockQuery).toHaveBeenNthCalledWith(4, 'ROLLBACK');

      // Verify client is released
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('applies custom statementTimeoutMs from request body', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1', statementTimeoutMs: 2500 });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith('SET LOCAL statement_timeout = 2500');
    });

    it('applies configured statementTimeoutMs from router deps', async () => {
      const app = createTestApp({ statementTimeoutMs: 3000 });
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith('SET LOCAL statement_timeout = 3000');
    });

    it('returns raw rows when QUERY PLAN column is absent', async () => {
      const app = createTestApp();
      const rawRows = [{ id: 1, name: 'test' }];
      mockQuery.mockImplementation(async (sql: string) => {
        if (
          sql === 'BEGIN READ ONLY' ||
          sql.startsWith('SET LOCAL statement_timeout') ||
          sql === 'ROLLBACK'
        ) {
          return { rows: [] };
        }
        return { rows: rawRows } as unknown as QueryResult;
      });

      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT id, name FROM users LIMIT 1' });

      expect(res.status).toBe(200);
      expect(res.body.plan).toEqual(rawRows);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('passes parameters to the database query', async () => {
      const app = createTestApp();
      await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users WHERE id = $1 AND status = $2', params: [1, 'active'] });

      expect(mockQuery).toHaveBeenCalledWith(
        'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM users WHERE id = $1 AND status = $2',
        [1, 'active'],
      );
    });

    it('supports duck-typed pool without connect() method (legacy fallback)', async () => {
      const duckTypedPool = {
        query: mockQuery,
      } as unknown as Pool;

      const app = createTestApp({ pool: duckTypedPool });
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith('BEGIN READ ONLY');
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('Acceptance Criteria: read-only transaction and statement timeout guarantees', () => {
    it('rejects a DELETE inside a CTE before database execution (no rows change)', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'WITH d AS (DELETE FROM users RETURNING 1) SELECT * FROM d' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('not allowed');
      // No database queries executed — no rows change
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rolls back and releases client if a read-only transaction error is returned by DB', async () => {
      const app = createTestApp();
      const readOnlyError = new Error('cannot execute DELETE in a read-only transaction');
      (readOnlyError as unknown as Record<string, unknown>).code = '25006';

      mockQuery.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN READ ONLY' || sql.startsWith('SET LOCAL')) {
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          return { rows: [] };
        }
        throw readOnlyError;
      });

      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('cannot execute DELETE in a read-only transaction');

      // Crucial: ROLLBACK was called and client was released
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('cancels queries exceeding statement timeout and returns 400 with rollback and release', async () => {
      const app = createTestApp();
      const timeoutError = new Error('canceling statement due to statement timeout');
      (timeoutError as unknown as Record<string, unknown>).code = '57014';

      mockQuery.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN READ ONLY' || sql.startsWith('SET LOCAL')) {
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          return { rows: [] };
        }
        throw timeoutError;
      });

      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT pg_sleep(10)' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('statement timeout');

      // Crucial: transaction is rolled back and client is released back to pool
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('always releases the client even when ROLLBACK fails', async () => {
      const app = createTestApp();
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN READ ONLY' || sql.startsWith('SET LOCAL')) {
          return { rows: [] };
        }
        if (sql.startsWith('EXPLAIN')) {
          throw new Error('Connection lost during explain');
        }
        if (sql === 'ROLLBACK') {
          throw new Error('Connection closed');
        }
        return { rows: [] };
      });

      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Connection lost during explain');
      // Client is STILL released despite rollback throwing
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('supports execution against a ReplicaPool instance', async () => {
      const mockReadClient = {
        query: jest.fn(async (sql: string) => {
          if (
            sql === 'BEGIN READ ONLY' ||
            sql.startsWith('SET LOCAL statement_timeout') ||
            sql === 'ROLLBACK'
          ) {
            return { rows: [] };
          }
          return { rows: [makeExplainRow(SAMPLE_PLAN)] };
        }),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockReplicaPool = {
        getReadClient: jest.fn().mockResolvedValue(mockReadClient),
      } as unknown as ReplicaPool;

      const app = createTestApp({ replicaPool: mockReplicaPool });
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM users' });

      expect(res.status).toBe(200);
      expect(mockReplicaPool.getReadClient).toHaveBeenCalledTimes(1);
      expect(mockReadClient.query).toHaveBeenCalledWith('BEGIN READ ONLY');
      expect(mockReadClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockReadClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('audit logging', () => {
    it('logs an audit event on successful explain including statementTimeoutMs', async () => {
      const app = createTestApp();
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
          statementTimeoutMs: 5000,
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
      mockQuery.mockImplementation(async (sql: string) => {
        if (
          sql === 'BEGIN READ ONLY' ||
          sql.startsWith('SET LOCAL statement_timeout') ||
          sql === 'ROLLBACK'
        ) {
          return { rows: [] };
        }
        throw new Error('relation "does_not_exist" does not exist');
      });

      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT * FROM does_not_exist' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('does not exist');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('returns 400 for generic DB error', async () => {
      const app = createTestApp();
      mockQuery.mockImplementation(async (sql: string) => {
        if (
          sql === 'BEGIN READ ONLY' ||
          sql.startsWith('SET LOCAL statement_timeout') ||
          sql === 'ROLLBACK'
        ) {
          return { rows: [] };
        }
        throw 'string error';
      });

      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('EXPLAIN query execution failed');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('recovers after a failed query for subsequent successful queries', async () => {
      const app = createTestApp();
      let firstFailed = false;
      mockQuery.mockImplementation(async (sql: string) => {
        if (
          sql === 'BEGIN READ ONLY' ||
          sql.startsWith('SET LOCAL statement_timeout') ||
          sql === 'ROLLBACK'
        ) {
          return { rows: [] };
        }
        if (!firstFailed) {
          firstFailed = true;
          throw new Error('first failure');
        }
        return { rows: [makeExplainRow(SAMPLE_PLAN)] } as unknown as QueryResult;
      });

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

    it('propagates unexpected non-ZodError errors to the error handler', async () => {
      const unexpectedError = new TypeError('Unexpected runtime error');
      (logger.audit as jest.Mock).mockImplementationOnce(() => {
        throw unexpectedError;
      });

      const app = createTestApp();
      const res = await request(app)
        .post('/api/admin/db/explain')
        .send({ query: 'SELECT 1' });

      expect(res.status).toBe(500);
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
