/**
 * Tests for GET /api/refresh-token — cursor-paginated refresh token listing.
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

jest.mock('../config/env', () => ({
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
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { createRefreshTokenRouter } from './refresh-token.js';
import { encodeCursor } from '../lib/cursorPagination.js';
import type {
  RefreshToken,
  RefreshTokenRepository,
} from '../repositories/refreshTokenRepository.js';

jest.mock('../logger', () => {
  const actual = jest.requireActual('../logger');
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

import { logger } from '../logger.js';

const USER_ID = 'test-user-123';

function makeToken(overrides: Partial<RefreshToken> = {}): RefreshToken {
  return {
    id: 'token-1',
    userId: USER_ID,
    tokenHash: 'hash-1',
    expiresAt: new Date('2026-12-31T23:59:59.999Z'),
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    lastUsedAt: undefined,
    isRevoked: false,
    familyId: 'family-1',
    ...overrides,
  };
}

class MockRefreshTokenRepository implements RefreshTokenRepository {
  private tokens: RefreshToken[] = [];

  constructor(tokens: RefreshToken[] = []) {
    this.tokens = tokens;
  }

  setTokens(tokens: RefreshToken[]): void {
    this.tokens = tokens;
  }

  async createRefreshToken(token: Omit<RefreshToken, 'id'> & { id?: string }): Promise<RefreshToken> {
    const stored = { id: token.id || 'new-id', ...token } as RefreshToken;
    this.tokens.push(stored);
    return stored;
  }

  async findRefreshTokenById(tokenId: string, userId: string): Promise<RefreshToken | null> {
    return this.tokens.find((t) => t.id === tokenId && t.userId === userId) ?? null;
  }

  async findRefreshTokenByHash(tokenHash: string, userId: string): Promise<RefreshToken | null> {
    return this.tokens.find((t) => t.tokenHash === tokenHash && t.userId === userId) ?? null;
  }

  async updateLastUsed(tokenId: string, userId: string): Promise<void> {
    const token = this.tokens.find((t) => t.id === tokenId && t.userId === userId);
    if (token) token.lastUsedAt = new Date();
  }

  async revokeRefreshToken(tokenId: string, userId: string): Promise<void> {
    const token = this.tokens.find((t) => t.id === tokenId && t.userId === userId);
    if (token) token.isRevoked = true;
  }

  async revokeFamily(familyId: string, userId: string): Promise<void> {
    for (const token of this.tokens) {
      if (token.familyId === familyId && token.userId === userId) {
        token.isRevoked = true;
      }
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    for (const token of this.tokens) {
      if (token.userId === userId) token.isRevoked = true;
    }
  }

  async cleanupExpiredTokens(): Promise<number> {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter(
      (t) => t.expiresAt > new Date() && !t.isRevoked,
    );
    return before - this.tokens.length;
  }

  async countActiveTokens(userId: string): Promise<number> {
    return this.tokens.filter(
      (t) => t.userId === userId && t.expiresAt > new Date() && !t.isRevoked,
    ).length;
  }

  async listRefreshTokens(
    userId: string,
    limit: number,
    afterCursor?: { timestamp: Date; id: string },
  ): Promise<{ tokens: RefreshToken[]; hasMore: boolean }> {
    const userTokens = this.tokens
      .filter((t) => t.userId === userId)
      .sort((a, b) => {
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id.localeCompare(a.id);
      });

    let filtered = userTokens;
    if (afterCursor) {
      filtered = userTokens.filter((t) => {
        const timeDiff = t.createdAt.getTime() - afterCursor.timestamp.getTime();
        if (timeDiff < 0) return true;
        if (timeDiff > 0) return false;
        return t.id < afterCursor.id;
      });
    }

    const fetchLimit = limit + 1;
    const sliced = filtered.slice(0, fetchLimit);
    const hasMore = sliced.length > limit;
    if (hasMore) sliced.length = limit;

    return { tokens: sliced, hasMore };
  }
}

import { TokenBucketRateLimiter } from '../middleware/rateLimit.js';

function buildApp(
  repository: RefreshTokenRepository,
  rateLimiter?: TokenBucketRateLimiter,
) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    '/api/refresh-token',
    createRefreshTokenRouter({
      refreshTokenRepository: repository,
      rateLimiter,
    }),
  );
  app.use(errorHandler);
  return app;
}

const authHeader = { 'x-user-id': USER_ID };

describe('GET /api/refresh-token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the first page with nextCursor when more results exist', async () => {
    const tokens = [
      makeToken({ id: 'token-3', createdAt: new Date('2026-06-03T10:00:00.000Z') }),
      makeToken({ id: 'token-2', createdAt: new Date('2026-06-02T10:00:00.000Z') }),
      makeToken({ id: 'token-1', createdAt: new Date('2026-06-01T10:00:00.000Z') }),
    ];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token?limit=2').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: encodeCursor(new Date('2026-06-02T10:00:00.000Z'), 'token-2'),
    });
  });

  it('returns an empty page without nextCursor when no tokens exist', async () => {
    const repo = new MockRefreshTokenRepository([]);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toEqual({ limit: 20, hasMore: false });
    expect(res.body.meta.nextCursor).toBeUndefined();
  });

  it('returns last page without nextCursor when all results fit', async () => {
    const tokens = [
      makeToken({ id: 'token-2', createdAt: new Date('2026-06-02T10:00:00.000Z') }),
      makeToken({ id: 'token-1', createdAt: new Date('2026-06-01T10:00:00.000Z') }),
    ];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token?limit=5').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({ limit: 5, hasMore: false });
    expect(res.body.meta.nextCursor).toBeUndefined();
  });

  it('passes decoded cursor to the repository for subsequent pages', async () => {
    const tokens = [
      makeToken({ id: 'token-4', createdAt: new Date('2026-06-04T10:00:00.000Z') }),
      makeToken({ id: 'token-3', createdAt: new Date('2026-06-03T10:00:00.000Z') }),
      makeToken({ id: 'token-2', createdAt: new Date('2026-06-02T10:00:00.000Z') }),
      makeToken({ id: 'token-1', createdAt: new Date('2026-06-01T10:00:00.000Z') }),
    ];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    // First page
    const firstRes = await request(app).get('/api/refresh-token?limit=2').set(authHeader);
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.meta.hasMore).toBe(true);
    const cursor = firstRes.body.meta.nextCursor;

    // Second page using the cursor
    const secondRes = await request(app).get(`/api/refresh-token?limit=2&cursor=${cursor}`).set(authHeader);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.data).toHaveLength(2);
    expect(secondRes.body.data.map((t: { id: string }) => t.id)).toEqual(['token-2', 'token-1']);
    expect(secondRes.body.meta.hasMore).toBe(false);
    expect(secondRes.body.meta.nextCursor).toBeUndefined();
  });

  it('does not expose token_hash in the response', async () => {
    const tokens = [makeToken({ id: 'token-1', tokenHash: 'secret-hash-value' })];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).not.toHaveProperty('tokenHash');
    expect(res.body.data[0]).not.toHaveProperty('token_hash');
  });

  it('requires authentication', async () => {
    const repo = new MockRefreshTokenRepository([]);
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.use('/api/refresh-token', createRefreshTokenRouter({ refreshTokenRepository: repo }));
    app.use(errorHandler);

    const res = await request(app).get('/api/refresh-token');

    expect(res.status).toBe(401);
  });

  it('rejects an invalid cursor with a standardized validation error', async () => {
    const repo = new MockRefreshTokenRepository([]);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token?cursor=not-a-valid-cursor').set(authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query.cursor' }),
      ]),
    );
  });

  it('rejects a non-numeric limit', async () => {
    const repo = new MockRefreshTokenRepository([]);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token?limit=abc').set(authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'query.limit' }),
      ]),
    );
  });

  it('rejects a limit below 1', async () => {
    const repo = new MockRefreshTokenRepository([]);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token?limit=0').set(authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('clamps limit to maximum of 100', async () => {
    const tokens: RefreshToken[] = [];
    for (let i = 0; i < 150; i++) {
      const month = Math.floor(i / 28) + 6;
      const day = (i % 28) + 1;
      tokens.push(
        makeToken({
          id: `token-${i}`,
          createdAt: new Date(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T10:00:00.000Z`),
        }),
      );
    }
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token?limit=1000').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.meta.limit).toBe(100);
  });

  it('uses default limit of 20 when not specified', async () => {
    const tokens: RefreshToken[] = [];
    for (let i = 0; i < 25; i++) {
      const month = Math.floor(i / 28) + 6;
      const day = (i % 28) + 1;
      tokens.push(
        makeToken({
          id: `token-${i}`,
          createdAt: new Date(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T10:00:00.000Z`),
        }),
      );
    }
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.meta.limit).toBe(20);
    expect(res.body.meta.hasMore).toBe(true);
  });

  it('returns correct token fields in the response', async () => {
    const tokens = [
      makeToken({
        id: 'token-1',
        expiresAt: new Date('2026-12-31T23:59:59.999Z'),
        createdAt: new Date('2026-06-01T10:00:00.000Z'),
        lastUsedAt: new Date('2026-06-02T10:00:00.000Z'),
        isRevoked: false,
        familyId: 'family-abc',
      }),
    ];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      id: 'token-1',
      expiresAt: '2026-12-31T23:59:59.999Z',
      createdAt: '2026-06-01T10:00:00.000Z',
      lastUsedAt: '2026-06-02T10:00:00.000Z',
      isRevoked: false,
      familyId: 'family-abc',
    });
  });

  it('handles tokens with null lastUsedAt', async () => {
    const tokens = [
      makeToken({
        id: 'token-1',
        lastUsedAt: undefined,
      }),
    ];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data[0].lastUsedAt).toBeNull();
  });

  it('only returns tokens for the authenticated user', async () => {
    const tokens = [
      makeToken({ id: 'token-1', userId: USER_ID }),
      makeToken({ id: 'token-2', userId: 'other-user' }),
      makeToken({ id: 'token-3', userId: USER_ID }),
    ];
    const repo = new MockRefreshTokenRepository(tokens);
    const app = buildApp(repo);

    const res = await request(app).get('/api/refresh-token').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((t: { id: string }) => t.id)).toEqual(['token-3', 'token-1']);
  });

  it('logs the request with correlation ID', async () => {
    const repo = new MockRefreshTokenRepository([makeToken()]);
    const app = buildApp(repo);

    await request(app).get('/api/refresh-token?limit=5').set(authHeader);

    expect(logger.info).toHaveBeenCalledWith(
      'LIST_REFRESH_TOKENS',
      expect.objectContaining({
        userId: USER_ID,
        limit: 5,
        count: 1,
        hasMore: false,
      }),
    );
  });

  describe('X-Correlation-Id propagation (issue #957)', () => {
    it('always sets X-Correlation-Id response header', async () => {
      const repo = new MockRefreshTokenRepository([makeToken()]);
      const app = buildApp(repo);

      const res = await request(app).get('/api/refresh-token').set(authHeader);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBeDefined();
      expect(typeof res.headers['x-correlation-id']).toBe('string');
      expect(res.headers['x-correlation-id'].length).toBeGreaterThan(0);
    });

    it('propagates client-supplied x-correlation-id in response header', async () => {
      const repo = new MockRefreshTokenRepository([makeToken()]);
      const app = buildApp(repo);
      const clientCorrelationId = 'client-corr-test-abc-123';

      const res = await request(app)
        .get('/api/refresh-token')
        .set(authHeader)
        .set('x-correlation-id', clientCorrelationId);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
    });

    it('includes correlation ID in structured log output', async () => {
      const repo = new MockRefreshTokenRepository([makeToken()]);
      const app = buildApp(repo);

      await request(app).get('/api/refresh-token').set(authHeader);

      expect(logger.info).toHaveBeenCalledWith(
        'LIST_REFRESH_TOKENS',
        expect.objectContaining({
          correlationId: expect.any(String),
        }),
      );
    });

    it('includes correlation ID in error log when repository fails', async () => {
      const repo = new MockRefreshTokenRepository([]);
      jest.spyOn(repo, 'listRefreshTokens').mockRejectedValue(new Error('DB error'));
      const app = buildApp(repo);

      await request(app).get('/api/refresh-token').set(authHeader);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to list refresh tokens',
        expect.objectContaining({
          correlationId: expect.any(String),
        }),
      );
    });
  });

  describe('Token-Bucket Rate Limiting (issue #930)', () => {
    it('allows requests within capacity and rejects with HTTP 429 when capacity is exceeded', async () => {
      const repo = new MockRefreshTokenRepository([makeToken()]);
      // Limiter with capacity 2, refill rate 1 token/sec
      const limiter = new TokenBucketRateLimiter(2, 1);
      const app = buildApp(repo, limiter);

      // First 2 requests succeed (capacity: 2)
      const res1 = await request(app).get('/api/refresh-token').set(authHeader);
      expect(res1.status).toBe(200);

      const res2 = await request(app).get('/api/refresh-token').set(authHeader);
      expect(res2.status).toBe(200);

      // 3rd request exceeds capacity
      const res3 = await request(app).get('/api/refresh-token').set(authHeader);
      expect(res3.status).toBe(429);
      expect(res3.body).toEqual(
        expect.objectContaining({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too Many Requests',
        }),
      );
      expect(res3.body).toHaveProperty('requestId');
      expect(res3.body).toHaveProperty('retryAfterMs');
    });

    it('returns Retry-After header in whole seconds reflecting refill time', async () => {
      const repo = new MockRefreshTokenRepository([]);
      // Capacity 1, refill rate 0.5 (takes 2 seconds to refill 1 token)
      const limiter = new TokenBucketRateLimiter(1, 0.5);
      const app = buildApp(repo, limiter);

      const res1 = await request(app).get('/api/refresh-token').set(authHeader);
      expect(res1.status).toBe(200);

      const res2 = await request(app).get('/api/refresh-token').set(authHeader);
      expect(res2.status).toBe(429);

      // Retry-After header must be present and formatted as whole seconds string
      const retryAfterHeader = res2.headers['retry-after'];
      expect(retryAfterHeader).toBeDefined();
      expect(/^\d+$/.test(retryAfterHeader)).toBe(true);
      const seconds = parseInt(retryAfterHeader, 10);
      expect(seconds).toBeGreaterThanOrEqual(1);
    });

    it('enforces rate limit per-user in isolation', async () => {
      const repo = new MockRefreshTokenRepository([
        makeToken({ userId: 'user-A' }),
        makeToken({ userId: 'user-B' }),
      ]);
      const limiter = new TokenBucketRateLimiter(1, 1);
      const app = buildApp(repo, limiter);

      // User A consumes their token
      const resA1 = await request(app).get('/api/refresh-token').set('x-user-id', 'user-A');
      expect(resA1.status).toBe(200);

      const resA2 = await request(app).get('/api/refresh-token').set('x-user-id', 'user-A');
      expect(resA2.status).toBe(429);

      // User B should NOT be blocked by User A's rate limit
      const resB1 = await request(app).get('/api/refresh-token').set('x-user-id', 'user-B');
      expect(resB1.status).toBe(200);
    });

    it('falls back to client IP for rate limiting key when no user auth is present', async () => {
      const repo = new MockRefreshTokenRepository([]);
      const limiter = new TokenBucketRateLimiter(1, 1);
      const app = buildApp(repo, limiter);

      // First unauthenticated request consumes IP bucket, proceeds to auth middleware and returns 401
      const res1 = await request(app).get('/api/refresh-token');
      expect(res1.status).toBe(401);

      // Second request from same IP exceeds bucket capacity and returns 429
      const res2 = await request(app).get('/api/refresh-token');
      expect(res2.status).toBe(429);
      expect(res2.headers['retry-after']).toBeDefined();
    });

    it('logs structured warning with correlation ID when rate limit is exceeded', async () => {
      const repo = new MockRefreshTokenRepository([]);
      const limiter = new TokenBucketRateLimiter(1, 1);
      const app = buildApp(repo, limiter);

      await request(app).get('/api/refresh-token').set(authHeader).set('x-request-id', 'req-corr-999');
      await request(app).get('/api/refresh-token').set(authHeader).set('x-request-id', 'req-corr-999');

      expect(logger.warn).toHaveBeenCalledWith(
        '[tokenBucketRateLimit] request limit exceeded',
        expect.objectContaining({
          key: `user:${USER_ID}`,
          requestId: 'req-corr-999',
        }),
      );
    });

    it('returns 500 InternalServerError when repository listRefreshTokens throws unexpected error', async () => {
      const repo = new MockRefreshTokenRepository([]);
      jest.spyOn(repo, 'listRefreshTokens').mockRejectedValue(new Error('DB Connection Failed'));
      const app = buildApp(repo);

      const res = await request(app).get('/api/refresh-token').set(authHeader);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
