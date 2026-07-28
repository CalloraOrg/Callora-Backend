/**
 * Tests for GET /api/admin/audit — cursor-paginated audit log listing.
 *
 * Includes focused tests for ETag / 304 Not Modified caching behaviour.
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
  // Disable Express's built-in weak-ETag so assertions only target our strong
  // ETag middleware — prevents false positives from Express's auto-ETag.
  app.disable('etag');
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

// ---------------------------------------------------------------------------
// Pagination behaviour
// ---------------------------------------------------------------------------
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
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
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
    expect(res.body.error.details).toEqual(
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
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query.from' }),
      ]),
    );
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
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query.from' }),
      ]),
    );
  });

  it('requires admin authentication', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app).get('/api/admin/audit');

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ETag / 304 caching behaviour
// ---------------------------------------------------------------------------
describe('GET /api/admin/audit — ETag / 304 caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits a strong ETag header on a 200 response', async () => {
    const entries = [baseEntry()];
    const repo = new MockAuditLogRepository(() => ({ entries, hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    // Strong ETag: surrounded by double-quotes, no W/ prefix, 64 hex chars (SHA-256)
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('returns 304 Not Modified when If-None-Match matches the current ETag', async () => {
    const entries = [baseEntry()];
    const repo = new MockAuditLogRepository(() => ({ entries, hasMore: false }));
    const app = buildApp(repo);

    // First request — get the ETag
    const first = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    // Second request — conditional GET using the ETag
    const second = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns 304 when If-None-Match is a wildcard *', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [baseEntry()], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
  });

  it('returns 200 when If-None-Match does not match (data has changed)', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [baseEntry()], hasMore: false }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('If-None-Match', '"stale-etag-value"');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('returns a different ETag when the response content changes', async () => {
    const entries1 = [baseEntry({ id: 'audit-1' })];
    const entries2 = [baseEntry({ id: 'audit-2', event: 'DELETE_USER' })];

    let callCount = 0;
    const repo = new MockAuditLogRepository(() => {
      callCount++;
      return { entries: callCount === 1 ? entries1 : entries2, hasMore: false };
    });
    const app = buildApp(repo);

    const first = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);
    const second = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(first.headers.etag).toBeDefined();
    expect(second.headers.etag).toBeDefined();
    expect(first.headers.etag).not.toBe(second.headers.etag);
  });

  it('does NOT return 304 when client sends a weak ETag (strong comparison only)', async () => {
    const entries = [baseEntry()];
    const repo = new MockAuditLogRepository(() => ({ entries, hasMore: false }));
    const app = buildApp(repo);

    const first = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    const etag = first.headers.etag as string;
    // Build a weak ETag: W/"<hex>" — prepend W/ to the quoted digest
    const weakTag = `W/${etag}`;

    const second = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('If-None-Match', weakTag);

    // Strong comparison — weak client ETags must NOT match
    expect(second.status).toBe(200);
  });

  it('does not return an ETag for non-200 error responses', async () => {
    const repo = new MockAuditLogRepository(() => ({ entries: [], hasMore: false }));
    const app = buildApp(repo);

    // Hit the unauthenticated path — 401 should not carry our strong ETag
    // (Express's built-in ETag is disabled in buildApp)
    const res = await request(app).get('/api/admin/audit');

    expect(res.status).toBe(401);
    expect(res.headers.etag).toBeUndefined();
  });
});

describe('GET /api/admin/audit — security headers', () => {
  it('sets Content-Security-Policy on audit responses', async () => {
    const repo = new MockAuditLogRepository(() => ({
      entries: [baseEntry()],
      hasMore: false,
    }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-src 'none'");
  });

  it('sets X-Content-Type-Options: nosniff on audit responses', async () => {
    const repo = new MockAuditLogRepository(() => ({
      entries: [baseEntry()],
      hasMore: false,
    }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets Referrer-Policy on audit responses', async () => {
    const repo = new MockAuditLogRepository(() => ({
      entries: [baseEntry()],
      hasMore: false,
    }));
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('applies security headers even on error responses from the audit route', async () => {
    const repo = new MockAuditLogRepository(() => {
      throw new Error('unexpected');
    });
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', ADMIN_KEY);

    // Should return a 500 but still have security headers
    expect(res.status).toBe(500);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('applies security headers on the replay sub-route', async () => {
    const repo = new MockAuditLogRepository(() => ({
      entries: [baseEntry()],
      hasMore: false,
    }));
    const app = buildApp(repo);

    // Authenticated request to replay with an empty body — should reach the
    // router and get a 400 validation error, but security headers are set
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({});

    expect(res.status).toBe(400);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
