/**
 * Integration tests for GET /api/billing/credits  [b#044]
 *
 * Covers the full HTTP stack end-to-end using Supertest + the real
 * `createApp()` factory.  The SQLite layer (better-sqlite3) is mocked so the
 * suite runs without a local database file.  The CreditsRepository is stubbed
 * to return deterministic fixtures, keeping these tests fast and hermetic
 * while still exercising every middleware in the real request pipeline:
 *
 *   rate-limit → requireAuth → validate(query) → creditsHistogramMiddleware
 *   → handler → errorHandler
 *
 * Business rules verified:
 *  ✓ 401 – no Authorization header / malformed header / invalid JWT / expired JWT
 *  ✓ 200 – JWT Bearer token  (userId from `sub` or `userId` claim)
 *  ✓ 200 – x-user-id header  (local / test auth path)
 *  ✓ 200 – exact response shape and types
 *  ✓ 200 – ISO-8601 timestamps
 *  ✓ 200 – high-precision decimal balance (up to 7 d.p.)
 *  ✓ 200 – zero balance for a brand-new user (auto-created record)
 *  ✓ 400 – unexpected query parameter → VALIDATION_ERROR
 *  ✓ 500 – repository error propagates via errorHandler
 *  ✓ 429 – token-bucket rate limit kicks in after burst capacity is exhausted
 *  ✓ Retry-After header present on 429 responses
 *  ✓ Concurrent requests for the same user all succeed
 *  ✓ Correlation IDs (x-request-id) echoed in error envelopes
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Module mocks — must appear BEFORE any import that transitively loads the
// mocked modules (Jest hoists these to the top of the compiled file).
// ---------------------------------------------------------------------------

/**
 * Mock better-sqlite3 to prevent native binary binding errors in CI and on
 * Windows machines where the native add-on may not be compiled.
 */
jest.mock('better-sqlite3', () => {
  const mockDb = {
    prepare: jest.fn(() => ({
      get: jest.fn(() => null),
      run: jest.fn(),
      all: jest.fn(() => []),
    })),
    exec: jest.fn(),
    close: jest.fn(),
    transaction: jest.fn((fn: (...args: unknown[]) => unknown) => fn),
  };
  const MockDatabase = jest.fn(() => mockDb);
  return MockDatabase;
});

/** Stub the Credits repository so tests control every database response. */
jest.mock('../../src/repositories/creditsRepository.ts', () => ({
  defaultCreditsRepository: {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    updateBalance: jest.fn(),
    grant: jest.fn(),
  },
}));

/** Silence structured Pino logger output during tests. */
jest.mock('../../src/logger.ts', () => {
  const actual = jest.requireActual('../../src/logger.ts');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      fatal: jest.fn(),
      audit: jest.fn(),
      child: jest.fn().mockReturnThis(),
    },
    getRequestId: jest.fn(() => 'test-request-id'),
    runWithRequestContext: jest.fn((_id: unknown, cb: () => void) => cb()),
  };
});

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { createApp } from '../../src/app.js';
import { defaultCreditsRepository } from '../../src/repositories/creditsRepository.js';
import { resetCreditsRateLimit } from '../../src/routes/billing/credits.js';
import type { Credit } from '../../src/db/schema.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type MockCreditsRepo = {
  findByUserId: jest.Mock;
  getOrCreateByUserId: jest.Mock;
  updateBalance: jest.Mock;
  grant: jest.Mock;
};

const mockRepo = defaultCreditsRepository as unknown as MockCreditsRepo;

// ---------------------------------------------------------------------------
// Fixtures and token helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

const TEST_USER_ID = 'integration-test-user-001';
const OTHER_USER_ID = 'integration-test-user-002';

/** Generate a signed JWT whose payload uses the canonical `userId` claim. */
function signToken(userId: string, expiresIn: string | number = '1h'): string {
  return jwt.sign({ userId, sub: userId }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  } as jwt.SignOptions);
}

/** Generate a JWT whose payload uses ONLY the `sub` claim (no `userId`). */
function signSubOnlyToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

/** A fully-populated Credit fixture for `TEST_USER_ID`. */
function makeCredit(overrides: Partial<Credit> = {}): Credit {
  return {
    id: 1,
    user_id: TEST_USER_ID,
    balance_usdc: '42.50',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-03-15T08:30:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /api/billing/credits — Integration Tests [b#044]', () => {
  // Create a fresh Express app for every test so rate-limiter state, mock
  // call counts, and middleware singletons do not bleed between tests.
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCreditsRateLimit();
    app = createApp();
  });

  // =========================================================================
  // Authentication
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/billing/credits');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
        }),
      });
    });

    it('returns 401 when Authorization header has an invalid format (not Bearer)', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', 'Basic somebase64==');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          code: 'INVALID_AUTH_HEADER',
        }),
      });
    });

    it('returns 401 when Bearer token is garbage (unparseable JWT)', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', 'Bearer not.a.real.jwt.token');

      expect(res.status).toBe(401);
    });

    it('returns 401 when JWT is signed with the wrong secret', async () => {
      const badToken = jwt.sign({ userId: TEST_USER_ID }, 'wrong-secret', {
        algorithm: 'HS256',
      });

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${badToken}`);

      expect(res.status).toBe(401);
    });

    it('returns 401 when JWT token is expired', async () => {
      // expiresIn: '-1s' creates an immediately-expired token.
      const expiredToken = signToken(TEST_USER_ID, '-1s');

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          code: 'TOKEN_EXPIRED',
        }),
      });
    });

    it('returns 401 when JWT payload contains neither userId nor sub claim', async () => {
      const tokenWithoutUserId = jwt.sign({ email: 'test@example.com' }, JWT_SECRET, {
        algorithm: 'HS256',
      });

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${tokenWithoutUserId}`);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          code: 'MISSING_CLAIMS',
        }),
      });
    });

    it('authenticates successfully using the userId JWT claim', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('authenticates successfully using the sub JWT claim (no explicit userId)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(
        makeCredit({ user_id: OTHER_USER_ID }),
      );
      const token = signSubOnlyToken(OTHER_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledWith(OTHER_USER_ID);
    });

    it('authenticates successfully using the x-user-id header (local/test path)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', TEST_USER_ID);

      expect(res.status).toBe(200);
      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    });
  });

  // =========================================================================
  // 200 – Success: response shape and correctness
  // =========================================================================

  describe('Successful credit retrieval (200)', () => {
    it('returns a 200 response with the correct top-level keys', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(
        expect.arrayContaining(['balance_usdc', 'created_at', 'updated_at', 'user_id'])
      );
    });

    it('returns the correct field values from the repository', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.data).toMatchObject({
        user_id: TEST_USER_ID,
        balance_usdc: '42.50',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-03-15T08:30:00.000Z',
      });
    });

    it('returns all fields as strings (no type coercion to numbers)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(typeof res.body.data.user_id).toBe('string');
      expect(typeof res.body.data.balance_usdc).toBe('string');
      expect(typeof res.body.data.created_at).toBe('string');
      expect(typeof res.body.data.updated_at).toBe('string');
    });

    it('returns timestamps in ISO 8601 format', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(res.body.data.created_at).toMatch(iso8601Regex);
      expect(res.body.data.updated_at).toMatch(iso8601Regex);
    });

    it('returns zero balance for a brand-new user (auto-created record)', async () => {
      const newUserCredit: Credit = {
        id: 99,
        user_id: 'brand-new-user-xyz',
        balance_usdc: '0.00',
        created_at: new Date('2026-07-01T12:00:00.000Z'),
        updated_at: new Date('2026-07-01T12:00:00.000Z'),
      };
      mockRepo.getOrCreateByUserId.mockResolvedValue(newUserCredit);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', 'brand-new-user-xyz');

      expect(res.status).toBe(200);
      expect(res.body.data.balance_usdc).toBe('0.00');
      expect(res.body.data.user_id).toBe('brand-new-user-xyz');
      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledWith('brand-new-user-xyz');
    });

    it('preserves high-precision decimal balances (up to 7 decimal places)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(
        makeCredit({ balance_usdc: '1234.5678901' }),
      );
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.data.balance_usdc).toBe('1234.5678901');
    });

    it('handles very large balance amounts without float truncation', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(
        makeCredit({ balance_usdc: '999999.9999999' }),
      );

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', TEST_USER_ID);

      expect(res.body.data.balance_usdc).toBe('999999.9999999');
    });

    it('falls back to a current timestamp when credit timestamps are null', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(
        makeCredit({
          created_at: null as unknown as Date,
          updated_at: null as unknown as Date,
        }),
      );
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      // The route falls back to `new Date().toISOString()` when timestamps are
      // null.  Verify the fallback produces a valid ISO string.
      expect(res.body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(res.body.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('calls getOrCreateByUserId exactly once per request', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledTimes(1);
    });

    it('passes the authenticated user id — not a different user — to the repository', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(
        makeCredit({ user_id: OTHER_USER_ID }),
      );
      const token = signToken(OTHER_USER_ID);

      await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledWith(OTHER_USER_ID);
      expect(mockRepo.getOrCreateByUserId).not.toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('returns Content-Type: application/json', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', TEST_USER_ID);

      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // =========================================================================
  // 400 – Validation errors
  // =========================================================================

  describe('Validation (400)', () => {
    it('rejects requests that include unexpected query parameters', async () => {
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits?unexpected=value')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('rejects requests with multiple unexpected query parameters', async () => {
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits?foo=bar&baz=qux')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('does NOT call the repository when query validation fails', async () => {
      const token = signToken(TEST_USER_ID);

      await request(app)
        .get('/api/billing/credits?invalid=param')
        .set('Authorization', `Bearer ${token}`);

      expect(mockRepo.getOrCreateByUserId).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 500 – Repository/internal errors
  // =========================================================================

  describe('Error handling (500)', () => {
    it('returns 500 when the repository throws an unexpected error', async () => {
      mockRepo.getOrCreateByUserId.mockRejectedValue(
        new Error('Database connection lost'),
      );
      const token = signToken(TEST_USER_ID);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
        }),
      });
    });

    it('never leaks internal error messages to the client in test mode', async () => {
      mockRepo.getOrCreateByUserId.mockRejectedValue(
        new Error('Sensitive DB connection string: postgres://admin:secret@host'),
      );

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', TEST_USER_ID);

      expect(res.status).toBe(500);
      // The raw internal error detail must not appear in the response body.
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('postgres://');
      expect(bodyStr).not.toContain('secret');
    });

    it('propagates via errorHandler, which attaches a requestId to the envelope', async () => {
      mockRepo.getOrCreateByUserId.mockRejectedValue(new Error('boom'));

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', TEST_USER_ID)
        .set('x-request-id', 'req-correlation-abc');

      expect(res.status).toBe(500);
      // The error envelope must include a requestId field.
      expect(res.body).toHaveProperty('requestId');
    });
  });

  // =========================================================================
  // 429 – Rate limiting
  // =========================================================================

  describe('Rate limiting (429)', () => {
    it('allows requests within the burst capacity (10 tokens)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      responses.forEach((res) => expect(res.status).toBe(200));
    });

    it('returns 429 once burst capacity is exceeded (11th request)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const responses = await Promise.all(
        Array.from({ length: 11 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      const rateLimited = responses.filter((r) => r.status === 429);
      expect(rateLimited.length).toBeGreaterThanOrEqual(1);
    });

    it('includes a Retry-After header on 429 responses', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const responses = await Promise.all(
        Array.from({ length: 12 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      const rateLimitedRes = responses.find((r) => r.status === 429);
      expect(rateLimitedRes).toBeDefined();
      expect(rateLimitedRes?.headers['retry-after']).toBeDefined();
    });

    it('includes retryAfterMs in the 429 response body', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());
      const token = signToken(TEST_USER_ID);

      const responses = await Promise.all(
        Array.from({ length: 12 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      const rateLimitedRes = responses.find((r) => r.status === 429);
      expect(rateLimitedRes).toBeDefined();
      expect(rateLimitedRes?.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(rateLimitedRes?.body.error.retryAfterMs).toBeGreaterThan(0);
    });

    it('tracks rate limits independently per user (user A exhausted does not affect user B)', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit());

      const tokenA = signToken('rate-limit-user-A');
      const tokenB = signToken('rate-limit-user-B');

      // Exhaust user A's bucket
      const responsesA = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${tokenA}`),
        ),
      );

      // User B should still get 200s
      const responsesB = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${tokenB}`),
        ),
      );

      responsesA.forEach((r) => expect(r.status).toBe(200));
      responsesB.forEach((r) => expect(r.status).toBe(200));
    });
  });

  // =========================================================================
  // Concurrency / Idempotency
  // =========================================================================

  describe('Concurrency', () => {
    it('handles concurrent requests from the same user without race conditions', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(makeCredit({ balance_usdc: '75.25' }));
      const token = signToken(TEST_USER_ID);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.balance_usdc).toBe('75.25');
      });

      // Repository must be called once per request (no caching across requests)
      expect(mockRepo.getOrCreateByUserId).toHaveBeenCalledTimes(5);
    });

    it('handles concurrent requests from different users independently', async () => {
      mockRepo.getOrCreateByUserId
        .mockImplementation((userId: string) =>
          Promise.resolve(makeCredit({ user_id: userId, balance_usdc: '10.00' })),
        );

      const users = ['concurrency-user-1', 'concurrency-user-2', 'concurrency-user-3'];

      const responses = await Promise.all(
        users.map((userId) =>
          request(app)
            .get('/api/billing/credits')
            .set('x-user-id', userId),
        ),
      );

      responses.forEach((res, i) => {
        expect(res.status).toBe(200);
        expect(res.body.data.user_id).toBe(users[i]);
      });
    });
  });
});
