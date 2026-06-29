/**
 * Tests for GET /api/admin/audit — cursor-paginated audit log listing.
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

jest.mock('../../config/env', () => ({
  env: {
    PORT: 3000,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/callora_test',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'callora_test',
    DB_POOL_MAX: 1,
    DB_IDLE_TIMEOUT_MS: 1000,
    DB_CONN_TIMEOUT_MS: 1000,
    JWT_SECRET: 'test-jwt-secret',
    ADMIN_API_KEY: 'test-admin-api-key',
    METRICS_API_KEY: 'test-metrics-api-key',
    UPSTREAM_URL: 'http://localhost:4000',
    PROXY_TIMEOUT_MS: 30000,
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    SOROBAN_RPC_ENABLED: false,
    HORIZON_ENABLED: false,
    STELLAR_TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    SOROBAN_TESTNET_RPC_URL: 'https://soroban-testnet.stellar.org',
    SOROBAN_MAINNET_RPC_URL: 'https://soroban-mainnet.stellar.org',
    STELLAR_BASE_FEE: 100,
    HEALTH_CHECK_DB_TIMEOUT: 2000,
    APP_VERSION: '1.0.0',
    LOG_LEVEL: 'info',
    GATEWAY_PROFILING_ENABLED: false,
  },
}));

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { createAdminAuditRouter } from './audit.js';
import { encodeCursor } from '../../lib/cursorPagination.js';
import type {
  AuditLogEntry,
  AuditLogRepository,
  FindAuditLogsCursorParams,
  FindAuditLogsCursorResult,
} from '../../repositories/auditLogRepository.js';

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

import { logger } from '../../logger.js';

const ADMIN_KEY = 'test-audit-admin-key';

const baseEntry = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'audit-1',
  event: 'LIST_USERS',
  actor: 'admin-api-key',
  tenantId: null,
  clientIp: '127.0.0.1',
  userAgent: 'jest',
  correlationId: 'req-1',
  bodyHash: null,
  details: { count: 1 },
  createdAt: '2026-06-28T10:00:00.000Z',
  ...overrides,
});

class MockAuditLogRepository implements AuditLogRepository {
  constructor(private readonly handler: (params: FindAuditLogsCursorParams) => FindAuditLogsCursorResult | Promise<FindAuditLogsCursorResult>) {}

  findCursor(params: FindAuditLogsCursorParams): Promise<FindAuditLogsCursorResult> {
    return Promise.resolve(this.handler(params));
  }
}

function buildApp(repository: AuditLogRepository) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'test' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });
  app.use('/api/admin/audit', createAdminAuditRouter({ auditLogRepository: repository }));
  app.use(errorHandler);
  return app;
}

describe('GET /api/admin/audit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the first page with nextCursor when more results exist', async () => {
    const entries = [
      baseEntry({ id: 'audit-3', createdAt: '2026-06-28T12:00:00.000Z' }),
      baseEntry({ id: 'audit-2', createdAt: '2026-06-28T11:00:00.000Z' }),
    ];
    const repo = new MockAuditLogRepository(() => ({ entries, hasMore: true }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit?limit=2')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: encodeCursor(new Date('2026-06-28T11:00:00.000Z'), 'audit-2'),
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_AUDIT_LOGS',
      'admin-api-key',
      expect.objectContaining({ count: 2, hasMore: true }),
    );
  });

  it('returns an empty page without nextCursor when no rows exist', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toEqual({ limit: 20, hasMore: false });
    expect(res.body.meta.nextCursor).toBeUndefined();
  });

  it('passes decoded cursor and filters to the repository', async () => {
    const cursor = encodeCursor(new Date('2026-06-28T11:00:00.000Z'), 'audit-2');
    const handler = jest.fn((): FindAuditLogsCursorResult => ({ entries: [], hasMore: false }));
    const app = buildApp(new MockAuditLogRepository(handler));

    await request(app)
      .get('/api/admin/audit')
      .query({
        cursor,
        limit: '5',
        event: 'LIST_USERS',
        tenant_id: 'dev-1',
        actor: 'admin-api-key',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T00:00:00.000Z',
      })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 5,
        event: 'LIST_USERS',
        tenantId: 'dev-1',
        actor: 'admin-api-key',
        afterCursor: {
          timestamp: new Date('2026-06-28T11:00:00.000Z'),
          id: 'audit-2',
        },
      }),
    );
  });

  it('rejects an invalid cursor with a standardized validation error', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit?cursor=not-a-valid-cursor')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query.cursor' }),
      ]),
    );
  });

  it('rejects a non-numeric limit', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit?limit=abc')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query.limit' }),
      ]),
    );
  });

  it('rejects an invalid from date', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit?from=not-a-date')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('from');
  });

  it('rejects when from is after to', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .query({
        from: '2026-06-30T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('from');
  });

  it('requires admin authentication', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app).get('/api/admin/audit');

    expect(res.status).toBe(401);
  });
});
