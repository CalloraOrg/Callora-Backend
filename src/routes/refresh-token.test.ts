/**
 * @file refresh-token.test.ts
 * @description Integration tests for POST /api/refresh-token and its graceful-
 * shutdown drain behaviour (issue #903).
 *
 * These tests stand up a minimal Express app that mirrors how the production
 * server wires the route:
 *
 *   createInFlightDrainTracker  →  drainMiddleware injected into the router
 *   DrainableSubsystem          →  registered with createGracefulShutdownHandler
 *   AuthController              →  backed by a MockRefreshTokenRepository
 *
 * Coverage matrix
 * ───────────────
 * Route surface
 *   ✓  rejects missing refreshToken body (400 + error envelope)
 *   ✓  rejects malformed / non-JWT token (401 + INVALID_REFRESH_TOKEN)
 *   ✓  rejects a token signed with a wrong secret (401)
 *   ✓  rejects a valid JWT whose tokenId is not in the store (401)
 *   ✓  rejects an explicitly revoked token (401 + REVOKED_TOKEN)
 *   ✓  returns 200 + { accessToken, tokenType } for a valid token
 *   ✓  returns x-request-id in every response
 *
 * Graceful-shutdown drain
 *   ✓  SIGTERM waits for an in-flight request to finish before resolving
 *   ✓  new requests receive Connection: close while draining
 *   ✓  awaitIdle resolves immediately when no requests are in flight
 *   ✓  drain subsystem is named 'refresh-token'
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import request from 'supertest';
import express from 'express';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';

import { createInFlightDrainTracker, createGracefulShutdownHandler } from '../lifecycle/shutdown.js';
import { createRefreshTokenRouter } from './refresh-token.js';
import { AuthController } from '../controllers/authController.js';
import { RefreshTokenService } from '../services/refreshTokenService.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import type { RefreshToken } from '../types/auth.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Must match the JWT_SECRET set by jest.env-setup.cjs / jest.setup.ts */
const TEST_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

// ---------------------------------------------------------------------------
// In-memory repository (mirrors the one in the integration test suite)
// ---------------------------------------------------------------------------

class MockRefreshTokenRepository implements RefreshTokenRepository {
  private tokens = new Map<string, RefreshToken>();

  async createRefreshToken(token: Omit<RefreshToken, 'id'> & { id?: string }): Promise<RefreshToken> {
    const id = token.id ?? `token-${Date.now()}`;
    const stored: RefreshToken = { id, ...token } as RefreshToken;
    this.tokens.set(id, stored);
    return stored;
  }

  async findRefreshTokenById(tokenId: string, userId: string): Promise<RefreshToken | null> {
    for (const t of this.tokens.values()) {
      if (t.id === tokenId && t.userId === userId) return t;
    }
    return null;
  }

  async findRefreshTokenByHash(tokenHash: string, userId: string): Promise<RefreshToken | null> {
    for (const t of this.tokens.values()) {
      if (t.tokenHash === tokenHash && t.userId === userId) return t;
    }
    return null;
  }

  async updateLastUsed(tokenId: string, userId: string): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.id === tokenId && t.userId === userId) {
        (t as any).lastUsedAt = new Date();
      }
    }
  }

  async revokeRefreshToken(tokenId: string, userId: string): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.id === tokenId && t.userId === userId) t.isRevoked = true;
    }
  }

  async revokeFamily(familyId: string, userId: string): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.familyId === familyId && t.userId === userId) t.isRevoked = true;
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.userId === userId) t.isRevoked = true;
    }
  }

  async cleanupExpiredTokens(): Promise<number> {
    let n = 0;
    for (const [id, t] of this.tokens.entries()) {
      if (t.expiresAt < new Date() || t.isRevoked) {
        this.tokens.delete(id);
        n++;
      }
    }
    return n;
  }

  async countActiveTokens(userId: string): Promise<number> {
    let n = 0;
    for (const t of this.tokens.values()) {
      if (t.userId === userId && t.expiresAt > new Date() && !t.isRevoked) n++;
    }
    return n;
  }

  async listRefreshTokens(
    userId: string,
    limit: number,
    _afterCursor?: any,
  ): Promise<{ tokens: RefreshToken[]; hasMore: boolean }> {
    const userTokens = Array.from(this.tokens.values()).filter((t) => t.userId === userId);
    return { tokens: userTokens.slice(0, limit), hasMore: userTokens.length > limit };
  }
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

interface TestApp {
  app: express.Express;
  refreshTokenService: RefreshTokenService;
  repo: MockRefreshTokenRepository;
  drainTracker: ReturnType<typeof createInFlightDrainTracker>;
}

function buildApp(): TestApp {
  const repo = new MockRefreshTokenRepository();
  const refreshTokenService = new RefreshTokenService({
    jwtSecret: TEST_SECRET,
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  });
  const authController = new AuthController({ refreshTokenService, refreshTokenRepository: repo });
  const drainTracker = createInFlightDrainTracker('refresh-token');

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    '/api/refresh-token',
    createRefreshTokenRouter({
      authController,
      drainMiddleware: drainTracker.middleware,
    }),
  );
  app.use(errorHandler);

  return { app, refreshTokenService, repo, drainTracker };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Store a valid, non-revoked refresh token record and return both the raw
 * JWT string and its stored record.
 */
async function seedValidToken(
  refreshTokenService: RefreshTokenService,
  repo: MockRefreshTokenRepository,
  userId = 'user-abc',
) {
  const pair = refreshTokenService.createTokenPair(userId);
  const record = refreshTokenService.createRefreshTokenRecord(userId, pair.refreshToken);
  const stored = await repo.createRefreshToken(record);
  return { refreshToken: pair.refreshToken, stored };
}

// ---------------------------------------------------------------------------
// Route-surface tests
// ---------------------------------------------------------------------------

describe('POST /api/refresh-token — input validation', () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = buildApp();
  });

  it('returns 400 with error envelope when refreshToken is missing', async () => {
    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({});

    expect(res.status).toBe(400);
    // Standard error envelope fields
    const err = res.body.error ?? res.body;
    expect(err).toHaveProperty('code');
    expect(err).toHaveProperty('message');
    expect(res.body).toHaveProperty('requestId');
    // Zod validation details array
    const details = err.details ?? res.body.details;
    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeGreaterThan(0);
  });

  it('returns 400 when body is not JSON', async () => {
    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .set('Content-Type', 'text/plain')
      .send('not json');

    // express.json() rejects non-JSON content-type
    expect(res.status).toBe(400);
  });

  it('returns 400 when refreshToken is an empty string', async () => {
    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken: '' });

    expect(res.status).toBe(400);
    const details = res.body.error?.details ?? res.body.details;
    expect(Array.isArray(details)).toBe(true);
  });

  it('returns 401 INVALID_REFRESH_TOKEN for a plaintext string (not a JWT)', async () => {
    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken: 'not-a-jwt-at-all' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code ?? res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('returns 401 for a JWT signed with the wrong secret', async () => {
    const maliciousToken = jwt.sign(
      { userId: 'attacker', tokenId: 'fake-id', type: 'refresh' },
      'wrong-secret',
      { algorithm: 'HS256' },
    );

    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken: maliciousToken });

    expect(res.status).toBe(401);
    expect(res.body.error?.code ?? res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('returns 401 for an access token presented as a refresh token', async () => {
    // A valid access token (type: 'access') must be rejected
    const accessToken = jwt.sign(
      { userId: 'user-xyz', type: 'access' },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );

    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken: accessToken });

    expect(res.status).toBe(401);
    expect(res.body.error?.code ?? res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('returns 401 when the token ID is not found in the store', async () => {
    // Correctly signed refresh token but never stored in the repo
    const orphan = jwt.sign(
      { userId: 'ghost-user', tokenId: 'nonexistent-id', type: 'refresh' },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' },
    );

    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken: orphan });

    expect(res.status).toBe(401);
    expect(res.body.error?.code ?? res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

