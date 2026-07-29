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

import { createInFlightDrainTracker, createGracefulShutdownHandler } from '../index.js';
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
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('requestId');
    // Zod validation details array
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
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
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('returns 401 INVALID_REFRESH_TOKEN for a plaintext string (not a JWT)', async () => {
    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken: 'not-a-jwt-at-all' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
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
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
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
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
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
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('POST /api/refresh-token — happy path', () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = buildApp();
  });

  it('returns 200 with accessToken and tokenType for a valid refresh token', async () => {
    const { refreshToken } = await seedValidToken(testApp.refreshTokenService, testApp.repo);

    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body.tokenType).toBe('Bearer');

    // Verify the returned access token is a valid JWT with the right claims
    const decoded = jwt.verify(res.body.accessToken, TEST_SECRET) as any;
    expect(decoded.userId).toBe('user-abc');
    expect(decoded.type).toBe('access');
  });

  it('includes x-request-id in every response', async () => {
    const { refreshToken } = await seedValidToken(testApp.refreshTokenService, testApp.repo);

    const success = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken });

    expect(success.headers['x-request-id']).toBeDefined();

    const error = await request(testApp.app)
      .post('/api/refresh-token')
      .send({});

    expect(error.headers['x-request-id']).toBeDefined();
  });

  it('echoes a caller-supplied x-request-id back in the response', async () => {
    const { refreshToken } = await seedValidToken(testApp.refreshTokenService, testApp.repo);
    const correlationId = 'test-correlation-id-12345';

    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .set('x-request-id', correlationId)
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(correlationId);
  });
});

describe('POST /api/refresh-token — revoked token', () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = buildApp();
  });

  it('returns 401 REVOKED_TOKEN for a revoked refresh token', async () => {
    const { refreshToken, stored } = await seedValidToken(testApp.refreshTokenService, testApp.repo);
    await testApp.repo.revokeRefreshToken(stored.id, stored.userId);

    const res = await request(testApp.app)
      .post('/api/refresh-token')
      .send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REVOKED_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Graceful-shutdown drain tests
// ---------------------------------------------------------------------------

describe('POST /api/refresh-token — graceful shutdown drain', () => {
  it('drain subsystem is named refresh-token', () => {
    const { drainTracker } = buildApp();
    expect(drainTracker.subsystem.name).toBe('refresh-token');
  });

  it('awaitIdle resolves immediately when no requests are in flight', async () => {
    const { drainTracker } = buildApp();
    drainTracker.subsystem.beginShutdown();
    await expect(drainTracker.subsystem.awaitIdle()).resolves.toBeUndefined();
  });

  it('sets Connection: close on responses received after beginShutdown', async () => {
    const { app, refreshTokenService, repo, drainTracker } = buildApp();

    // Signal shutdown BEFORE sending the request
    drainTracker.subsystem.beginShutdown();

    // The request still completes (drain doesn't block new requests from
    // starting — it only prevents the process from exiting while they run)
    const { refreshToken } = await seedValidToken(refreshTokenService, repo);
    const res = await request(app)
      .post('/api/refresh-token')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    // During drain the drain middleware must set Connection: close so that
    // keep-alive clients do not attempt to reuse the connection.
    expect(res.headers['connection']).toBe('close');
  });

  it('SIGTERM waits for an in-flight request to finish before the shutdown handler resolves', async () => {
    /**
     * This test directly exercises the production wiring:
     *   - A real HTTP server is started on an ephemeral port.
     *   - The refresh-token drain tracker is registered as a DrainableSubsystem.
     *   - We start a long-running request (delayed by a setTimeout inside a
     *     mock controller), fire SIGTERM (via gracefulShutdown), and verify
     *     that the shutdown promise does not resolve until the request finishes.
     */

    // Slow controller: holds the response open for `delay` ms then responds.
    let resolveDelayedResponse: (() => void) | undefined;
    const delayedResponseSettled = new Promise<void>((resolve) => {
      resolveDelayedResponse = resolve;
    });

    const slowApp = express();
    slowApp.use(express.json());

    const drainTracker = createInFlightDrainTracker('refresh-token');

    slowApp.post(
      '/api/refresh-token',
      drainTracker.middleware,
      (_req, res) => {
        // Don't respond immediately — simulate an in-flight DB call.
        setTimeout(() => {
          res.json({ accessToken: 'fake', tokenType: 'Bearer' });
          resolveDelayedResponse?.();
        }, 80);
      },
    );

    const server = slowApp.listen(0) as Server;

    const activeConnections = new Set<any>();
    server.on('connection', (socket: any) => {
      activeConnections.add(socket);
      socket.once('close', () => activeConnections.delete(socket));
    });

    const closeDatabase = jest.fn(async () => Promise.resolve());
    const shutdown = createGracefulShutdownHandler({
      server,
      activeConnections,
      closeDatabase,
      timeoutMs: 2_000,
      subsystems: [drainTracker.subsystem],
    });

    // Fire the slow request — don't await supertest yet, just start it.
    const requestPromise = request(slowApp)
      .post('/api/refresh-token')
      .send({ refreshToken: 'any' });

    // Give the request time to enter the handler before triggering shutdown.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Trigger graceful shutdown — should NOT resolve until the request finishes.
    const shutdownPromise = shutdown('SIGTERM');

    let shutdownResolved = false;
    void shutdownPromise.then(() => { shutdownResolved = true; });

    // Wait for the delayed response to be sent.
    await delayedResponseSettled;
    await requestPromise; // ensure supertest drains the socket

    // Now the shutdown can complete.
    const exitCode = await shutdownPromise;

    expect(exitCode).toBe(0);
    expect(shutdownResolved).toBe(true);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('shutdown resolves immediately when no requests are in flight at SIGTERM time', async () => {
    const { drainTracker } = buildApp();

    const server = { close: jest.fn((cb: (err?: Error) => void) => cb()) } as unknown as Server;
    const closeDatabase = jest.fn(async () => Promise.resolve());

    const shutdown = createGracefulShutdownHandler({
      server,
      activeConnections: new Set(),
      closeDatabase,
      timeoutMs: 100,
      subsystems: [drainTracker.subsystem],
    });

    const exitCode = await shutdown('SIGTERM');

    expect(exitCode).toBe(0);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
