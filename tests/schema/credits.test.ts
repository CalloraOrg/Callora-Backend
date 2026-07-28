/**
 * Response schema stability test for GET /api/billing/credits
 *
 * Snapshot tests that assert the /api/billing/credits response shape doesn't
 * drift accidentally across code changes. Uses inline snapshots and Jest
 * toMatchSnapshot() to lock down the expected response schema keys and types.
 *
 * Covers:
 *  - 200 success shape: exact top-level keys and field types
 *  - New-user auto-creation: zero-balance default response
 *  - Existing-user: non-zero balance shape
 *  - 401 unauthenticated: standardized error envelope shape
 *  - 400 extra query param: VALIDATION_ERROR error envelope shape
 *  - Full structural snapshot for schema-drift CI detection
 *
 * Closes #688
 */

import express from 'express';
import type { Application } from 'express';
import request from 'supertest';

// ---- mocks declared BEFORE any imports that pull the real modules ----

// Mock the metrics registry to avoid Prometheus histogram registration conflicts
jest.mock('../../src/metrics/registry', () => ({
  recordCreditsDuration: jest.fn(),
  recordBillingDeductDuration: jest.fn(),
  recordRefreshTokenDuration: jest.fn(),
  resetBillingDeductMetrics: jest.fn(),
  resetRefreshTokenMetrics: jest.fn(),
  billingDeductDuration: { observe: jest.fn(), reset: jest.fn() },
  refreshTokenDuration: { observe: jest.fn(), reset: jest.fn() },
}));

// Mock better-sqlite3 to prevent native binding errors in CI
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return {
        get: () => null,
        run: () => ({ changes: 1 }),
        all: () => [],
      };
    }
    exec() {}
    close() {}
    transaction(fn: (...args: unknown[]) => unknown) {
      return fn;
    }
  };
});

// Mock the drizzle db layer to prevent real DB connections
jest.mock('../../src/db/index', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  },
  schema: {
    credits: {},
  },
  sqlite: {
    prepare: jest.fn(() => ({ get: jest.fn() })),
    transaction: jest.fn((fn: (...args: unknown[]) => unknown) => fn),
  },
}));

// Mock the credits repository so tests are not coupled to a real database
jest.mock('../../src/repositories/creditsRepository', () => ({
  defaultCreditsRepository: {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    updateBalance: jest.fn(),
    grant: jest.fn(),
  },
}));

// Mock the logger to suppress log output during tests
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    audit: jest.fn(),
    debug: jest.fn(),
  },
  getRequestId: jest.fn(() => 'test-request-id'),
  runWithRequestContext: jest.fn((_: unknown, callback: () => void) => callback()),
}));

// ---- import modules AFTER mocks are configured ----
import creditsRouter, { resetCreditsRateLimit } from '../../src/routes/billing/credits';
import { errorHandler } from '../../src/middleware/errorHandler';
import { defaultCreditsRepository } from '../../src/repositories/creditsRepository';
import type { Credit } from '../../src/db/schema';

// Fixed timestamps for deterministic snapshot output
const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const FIXED_UPDATED_AT = new Date('2026-03-15T08:30:00.000Z');
const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000688';

/** Minimal fixture for a developer with a non-zero credit balance */
const fixtureCredit: Credit = {
  id: 1,
  user_id: 'dev-schema-test-user',
  balance_usdc: '42.50',
  created_at: FIXED_CREATED_AT,
  updated_at: FIXED_UPDATED_AT,
};

/** Minimal fixture representing a brand-new user's auto-created record */
const fixtureNewUserCredit: Credit = {
  id: 2,
  user_id: 'new-user-no-history',
  balance_usdc: '0.00',
  created_at: FIXED_CREATED_AT,
  updated_at: FIXED_CREATED_AT,
};

const mockRepo = defaultCreditsRepository as {
  findByUserId: jest.Mock;
  getOrCreateByUserId: jest.Mock;
  updateBalance: jest.Mock;
  grant: jest.Mock;
};

// ───────────────────────────────────────────────────────────────────────────
// Test suite
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/billing/credits — Response Schema Stability', () => {
  let app: Application;

  beforeEach(() => {
    // Mount the credits router in a minimal Express app
    app = express();
    app.use(express.json());
    // Simulate the x-request-id header that the real app's requestIdMiddleware sets
    app.use((req, _res, next) => {
      req.headers['x-request-id'] = req.headers['x-request-id'] ?? FIXED_REQUEST_ID;
      next();
    });
    app.use('/api/billing/credits', creditsRouter);
    app.use(errorHandler);

    jest.clearAllMocks();
    resetCreditsRateLimit();
  });

  // ── 200 Success shape ───────────────────────────────────────────────────

  describe('200 success response shape', () => {
    beforeEach(() => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(fixtureCredit);
    });

    it('returns exactly four top-level fields: user_id, balance_usdc, created_at, updated_at', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toMatchInlineSnapshot(`
[
  "balance_usdc",
  "created_at",
  "updated_at",
  "user_id",
]
`);
    });

    it('returns all fields as strings', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);
      expect(typeof res.body.user_id).toBe('string');
      expect(typeof res.body.balance_usdc).toBe('string');
      expect(typeof res.body.created_at).toBe('string');
      expect(typeof res.body.updated_at).toBe('string');
    });

    it('returns ISO 8601 timestamps for created_at and updated_at', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);
      // ISO 8601 full date-time: YYYY-MM-DDTHH:mm:ss.sssZ
      const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(res.body.created_at).toMatch(iso8601);
      expect(res.body.updated_at).toMatch(iso8601);
      // Timestamps must be parseable
      expect(new Date(res.body.created_at).getTime()).not.toBeNaN();
      expect(new Date(res.body.updated_at).getTime()).not.toBeNaN();
    });

    it('returns user_id that matches the authenticated user', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe(fixtureCredit.user_id);
    });

    it('returns balance_usdc as a numeric decimal string', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);
      // Must be parseable as a finite number
      expect(Number.isFinite(Number(res.body.balance_usdc))).toBe(true);
    });

    it('matches the full 200 success response shape snapshot', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);

      // Stabilize dynamic values for a deterministic snapshot
      const stabilized = {
        ...res.body,
        created_at: '<CREATED_AT>',
        updated_at: '<UPDATED_AT>',
      };
      expect(stabilized).toMatchSnapshot('credits-200-success-schema');
    });
  });

  // ── New-user (zero balance) response ────────────────────────────────────

  describe('new user — zero balance auto-creation', () => {
    beforeEach(() => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(fixtureNewUserCredit);
    });

    it('returns balance_usdc of "0.00" for a freshly-created credits record', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureNewUserCredit.user_id);

      expect(res.status).toBe(200);
      expect(res.body.balance_usdc).toBe('0.00');
    });

    it('returns the same four top-level keys regardless of balance value', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureNewUserCredit.user_id);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        ['balance_usdc', 'created_at', 'updated_at', 'user_id'],
      );
    });

    it('matches the zero-balance response shape snapshot', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureNewUserCredit.user_id);

      expect(res.status).toBe(200);
      const stabilized = {
        ...res.body,
        created_at: '<CREATED_AT>',
        updated_at: '<UPDATED_AT>',
      };
      expect(stabilized).toMatchSnapshot('credits-200-zero-balance-schema');
    });
  });

  // ── Large / high-precision balance ──────────────────────────────────────

  describe('high-precision balance values', () => {
    it('preserves up to 7 decimal places without coercion', async () => {
      const precisionCredit: Credit = {
        ...fixtureCredit,
        balance_usdc: '123456.7654321',
      };
      mockRepo.getOrCreateByUserId.mockResolvedValue(precisionCredit);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);
      // Value must be returned as a string, not a number (to preserve precision)
      expect(typeof res.body.balance_usdc).toBe('string');
      expect(res.body.balance_usdc).toBe('123456.7654321');
    });
  });

  // ── 401 Unauthenticated ─────────────────────────────────────────────────

  describe('401 error shape — unauthenticated request', () => {
    it('returns HTTP 401 when no auth credentials are provided', async () => {
      const res = await request(app).get('/api/billing/credits');

      expect(res.status).toBe(401);
    });

    it('returns the standardized error envelope with success=false', async () => {
      const res = await request(app).get('/api/billing/credits');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns the standardized error envelope with the correct shape', async () => {
      const res = await request(app).get('/api/billing/credits');

      expect(res.status).toBe(401);
      // Top-level keys of the error envelope
      expect(Object.keys(res.body).sort()).toEqual(
        expect.arrayContaining(['error', 'requestId', 'success', 'timestamp']),
      );
      // error sub-object must have code and message
      expect(res.body.error).toBeDefined();
      expect(typeof res.body.error.code).toBe('string');
      expect(typeof res.body.error.message).toBe('string');
    });

    it('returns UNAUTHORIZED error code', async () => {
      const res = await request(app).get('/api/billing/credits');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('matches the 401 error envelope shape snapshot', async () => {
      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(401);
      // timestamp is dynamic; match it with expect.any(String)
      expect(res.body).toMatchSnapshot({ timestamp: expect.any(String) });
    });
  });

  // ── 400 Validation error ────────────────────────────────────────────────

  describe('400 error shape — unexpected query parameter', () => {
    it('returns HTTP 400 when an unrecognized query param is provided', async () => {
      const res = await request(app)
        .get('/api/billing/credits?unexpected=param')
        .set('x-user-id', 'any-user');

      expect(res.status).toBe(400);
    });

    it('returns the standardized error envelope with VALIDATION_ERROR code', async () => {
      const res = await request(app)
        .get('/api/billing/credits?unexpected=param')
        .set('x-user-id', 'any-user');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toMatch(/VALIDATION_ERROR|BAD_REQUEST/);
    });

    it('matches the 400 error envelope shape snapshot', async () => {
      const res = await request(app)
        .get('/api/billing/credits?unexpected=param')
        .set('x-user-id', 'any-user')
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ timestamp: expect.any(String) });
    });
  });

  // ── Full schema-drift structural snapshot ───────────────────────────────

  describe('structural snapshot — schema drift detection', () => {
    it('matches the complete structural snapshot for a typical credits response', async () => {
      mockRepo.getOrCreateByUserId.mockResolvedValue(fixtureCredit);

      const res = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', fixtureCredit.user_id);

      expect(res.status).toBe(200);

      // Capture shape metadata (keys + value types) for stable assertion
      const schemaShape = {
        keys: Object.keys(res.body).sort(),
        user_id_type: typeof res.body.user_id,
        balance_usdc_type: typeof res.body.balance_usdc,
        created_at_type: typeof res.body.created_at,
        updated_at_type: typeof res.body.updated_at,
      };

      expect(schemaShape).toMatchInlineSnapshot(`
{
  "balance_usdc_type": "string",
  "created_at_type": "string",
  "keys": [
    "balance_usdc",
    "created_at",
    "updated_at",
    "user_id",
  ],
  "updated_at_type": "string",
  "user_id_type": "string",
}
`);
    });
  });
});
