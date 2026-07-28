/**
 * Tests for POST /api/admin/billing/credits/grant
 *
 * Covers:
 *  - Happy path: credits granted, +4 USDC buffer applied, 201 response with data envelope
 *  - Buffer math: integer amounts, decimal amounts, large amounts
 *  - Input validation: zero amounts, negative amounts, too many decimal places, non-numeric
 *  - Schema strictness: unknown fields rejected
 *  - Authentication: missing key returns 401, wrong key returns 401
 *  - user_id validation: empty, too long, missing
 *  - Error handling: repository throws AppError, repository throws generic Error
 *  - Response shape: updated_at is ISO-8601, campaign field, data envelope
 *  - Audit logging: logger.audit called with correct fields
 */

import express from 'express';
import request from 'supertest';

import type { Credit } from '../../../../db/schema.js';
import { errorHandler } from '../../../../middleware/errorHandler.js';
import type { CreditsRepository } from '../../../../repositories/creditsRepository.js';
import { createAdminCreditGrantsRouter } from './grant.js';

// ─── Prevent better-sqlite3 from being instantiated at module load time ───────
jest.mock('../../../../db/index.js', () => ({
  db: {},
  sqlite: {
    transaction: jest.fn(() => jest.fn()),
    prepare: jest.fn(() => ({ get: jest.fn(), run: jest.fn() })),
  },
  schema: { credits: {} },
}));

// ─── Silence logger output in tests ──────────────────────────────────────────
const mockAudit = jest.fn();
jest.mock('../../../../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    audit: (...args: unknown[]) => mockAudit(...args),
  },
  getRequestId: jest.fn(),
  runWithRequestContext: jest.fn((_id: unknown, callback: () => unknown) => callback()),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────
const ADMIN_KEY = 'test-admin-key';

function makeCredit(overrides: Partial<Credit> = {}): Credit {
  const now = new Date('2026-07-24T00:00:00.000Z');
  return {
    id: 1,
    user_id: 'user_123',
    balance_usdc: '0.00',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildApp(creditsRepository: CreditsRepository) {
  const app = express();
  app.use(express.json());
  // Lightweight admin-auth stub matching the real middleware's res.locals contract
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });
  app.use('/api/admin/billing/credits', createAdminCreditGrantsRouter({ creditsRepository }));
  app.use(errorHandler);
  return app;
}

function makeRepository(grantResult: Credit = makeCredit({ balance_usdc: '25.50' })): jest.Mocked<CreditsRepository> {
  return {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    updateBalance: jest.fn(),
    grant: jest.fn().mockResolvedValue(grantResult),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/billing/credits/grant', () => {
  beforeEach(() => {
    mockAudit.mockClear();
  });

  describe('Happy path', () => {
    it('grants prepaid credits and returns 201 with data envelope', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '25.50' });

      expect(response.status).toBe(201);
      // +4 USDC buffer applied: 25.50 → 29.50
      expect(repository.grant).toHaveBeenCalledWith('user_123', '29.50');
      expect(response.body.data).toMatchObject({
        user_id: 'user_123',
        amount_usdc: '29.50',
        balance_usdc: '25.50',
        campaign: 'GrantFox FWC26',
      });
    });

    it('returns updated_at as an ISO-8601 timestamp string', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '10.00' });

      expect(response.status).toBe(201);
      expect(response.body.data.updated_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it('adds exactly +4 USDC buffer to an integer amount', async () => {
      const repository = makeRepository(makeCredit({ balance_usdc: '10.00', user_id: 'u1' }));
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'u1', amount_usdc: '6' });

      expect(repository.grant).toHaveBeenCalledWith('u1', '10');
      expect(response.status).toBe(201);
    });

    it('preserves decimal fraction when applying the buffer', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.0000001' });

      // 1 + 4 = 5, fraction preserved → '5.0000001'
      expect(repository.grant).toHaveBeenCalledWith('user_123', '5.0000001');
      expect(response.status).toBe(201);
    });

    it('handles large amounts without floating-point corruption', async () => {
      const repository = makeRepository(makeCredit({ balance_usdc: '100000.00' }));
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '99996' });

      // 99996 + 4 = 100000
      expect(repository.grant).toHaveBeenCalledWith('user_123', '100000');
      expect(response.status).toBe(201);
    });

    it('reflects the repository result balance in the response', async () => {
      const repository = makeRepository(makeCredit({ balance_usdc: '999.9999999' }));
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(201);
      expect(response.body.data.balance_usdc).toBe('999.9999999');
    });

    it('grants credits for an amount with max 7 decimal places', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '0.0000001' });

      expect(repository.grant).toHaveBeenCalledWith('user_123', '4.0000001');
      expect(response.status).toBe(201);
    });

    it('applies the buffer to an amount starting with 0.xxx (leading zero on whole part)', async () => {
      // Exercises the /^0+(?=\d)/ strip branch in the refine validator
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '0.5' });

      expect(repository.grant).toHaveBeenCalledWith('user_123', '4.5');
      expect(response.status).toBe(201);
    });

    it('applies the buffer correctly for a whole-number amount with no fraction', async () => {
      // Exercises the ternary `fraction ? '.${fraction}' : ''` false branch
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '10' });

      expect(repository.grant).toHaveBeenCalledWith('user_123', '14');
      expect(response.status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Input validation — amount_usdc
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Input validation – amount_usdc', () => {
    it.each([
      ['0', 'zero'],
      ['0.0000000', 'zero with decimals'],
      ['-1', 'negative integer'],
      ['-0.5', 'negative decimal'],
      ['1.00000001', 'more than 7 decimal places'],
      ['1e3', 'scientific notation'],
      ['abc', 'non-numeric string'],
      ['', 'empty string'],
      ['1.2.3', 'multiple decimal points'],
    ])('rejects invalid amount_usdc: %s (%s)', async (amount_usdc) => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('rejects a missing amount_usdc field', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123' });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('accepts a valid two-decimal amount', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(201);
      expect(repository.grant).toHaveBeenCalledWith('user_123', '5.00');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Input validation — user_id
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Input validation – user_id', () => {
    it('rejects a missing user_id field', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ amount_usdc: '1.00' });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('rejects an empty user_id', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: '', amount_usdc: '1.00' });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('rejects a user_id that is whitespace only (trimmed to empty)', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: '   ', amount_usdc: '1.00' });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('rejects a user_id that exceeds 255 characters', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'a'.repeat(256), amount_usdc: '1.00' });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('accepts a user_id exactly 255 characters long', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'a'.repeat(255), amount_usdc: '1.00' });

      expect(response.status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Schema strictness
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Schema strictness', () => {
    it('rejects unexpected fields in the request body', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00', campaign: 'override' });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('rejects a request with an extra admin_notes field', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00', admin_notes: 'test' });

      expect(response.status).toBe(400);
    });

    it('rejects an empty body', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({});

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Authentication', () => {
    it('returns 401 when admin API key is missing', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(401);
      expect(repository.grant).not.toHaveBeenCalled();
    });

    it('returns 401 when admin API key is wrong', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', 'wrong-key')
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(401);
      expect(repository.grant).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Error handling', () => {
    it('returns 500 when the repository throws an unexpected error', async () => {
      const repository = makeRepository();
      repository.grant.mockRejectedValue(new Error('DB connection lost'));

      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(500);
    });

    it('forwards AppError from the repository with its original status code', async () => {
      const { AppError } = await import('../../../../errors/index.js');
      const repository = makeRepository();
      repository.grant.mockRejectedValue(
        new AppError('Credits service unavailable', 503),
      );

      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(503);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Audit logging
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Audit logging', () => {
    it('emits a GRANT_PREPAID_CREDITS audit event on success', async () => {
      const repository = makeRepository();
      await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '5.00' });

      expect(mockAudit).toHaveBeenCalledWith(
        'GRANT_PREPAID_CREDITS',
        'admin-api-key',
        expect.objectContaining({
          campaign: 'GrantFox FWC26',
          userId: 'user_123',
          amountUsdc: '9.00',
        }),
      );
    });

    it('includes correlationId from x-request-id header in audit event', async () => {
      const repository = makeRepository();
      await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .set('x-request-id', 'req-abc-123')
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(mockAudit).toHaveBeenCalledWith(
        'GRANT_PREPAID_CREDITS',
        expect.any(String),
        expect.objectContaining({ correlationId: 'req-abc-123' }),
      );
    });

    it('does not emit an audit event when validation fails', async () => {
      const repository = makeRepository();
      await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '0' });

      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Response shape
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Response shape', () => {
    it('wraps the result in a data envelope', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('data');
      expect(Object.keys(response.body)).toEqual(['data']);
    });

    it('includes all expected fields in the data envelope', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(Object.keys(response.body.data).sort()).toEqual(
        ['user_id', 'amount_usdc', 'balance_usdc', 'campaign', 'updated_at'].sort(),
      );
    });

    it('sets Content-Type to application/json', async () => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc: '1.00' });

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });
});
