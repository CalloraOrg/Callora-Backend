/**
 * Tests for GET /api/credits — hot-path credits lookup backed by
 * idx_credits_lookup_hot (migrations/credits_index.sql).
 */
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) };
    }
    exec() {
      return undefined;
    }
    close() {
      return undefined;
    }
    transaction() {
      return (fn: () => void) => fn();
    }
  };
});

import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { createCreditsRouter } from './credits.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import type { Credit } from '../db/schema.js';
import type { CreditsRepository } from '../repositories/creditsRepository.js';

function buildMockRepo(overrides: Partial<CreditsRepository> = {}): CreditsRepository {
  return {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    updateBalance: jest.fn(),
    grant: jest.fn(),
    ...overrides,
  };
}

describe('GET /api/credits', () => {
  let app: Application;
  let creditsRepository: CreditsRepository;
  const JWT_SECRET = 'test-secret-key-for-credits-index';
  const TEST_USER_ID = 'user_credits_hot_path';

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  beforeEach(() => {
    creditsRepository = buildMockRepo();
    app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.use('/api/credits', createCreditsRouter({ creditsRepository }));
    app.use(errorHandler);
  });

  function generateToken(userId: string): string {
    return jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  }

  function mockCredit(userId = TEST_USER_ID): Credit {
    return {
      id: 1,
      user_id: userId,
      balance_usdc: '42.50',
      created_at: new Date('2024-01-15T10:30:00.000Z'),
      updated_at: new Date('2024-01-20T14:22:00.000Z'),
    };
  }

  describe('authentication boundary', () => {
    it('returns 401 with standardized error envelope when unauthenticated', async () => {
      const res = await request(app).get('/api/credits');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: {
          code: 'UNAUTHORIZED',
          message: expect.any(String),
        },
      });
      expect(creditsRepository.getOrCreateByUserId).not.toHaveBeenCalled();
    });

    it('returns 401 for malformed Authorization header', async () => {
      const res = await request(app)
        .get('/api/credits')
        .set('Authorization', 'NotBearer abc');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_AUTH_HEADER');
    });

    it('accepts x-user-id header auth', async () => {
      (creditsRepository.getOrCreateByUserId as jest.Mock).mockResolvedValue(mockCredit());

      const res = await request(app)
        .get('/api/credits')
        .set('x-user-id', TEST_USER_ID);

      expect(res.status).toBe(200);
      expect(creditsRepository.getOrCreateByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    });
  });

  describe('hot-path lookup', () => {
    it('returns balance for the authenticated user via indexed user_id filter', async () => {
      (creditsRepository.getOrCreateByUserId as jest.Mock).mockResolvedValue(mockCredit());

      const res = await request(app)
        .get('/api/credits')
        .set('Authorization', `Bearer ${generateToken(TEST_USER_ID)}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        user_id: TEST_USER_ID,
        balance_usdc: '42.50',
        created_at: '2024-01-15T10:30:00.000Z',
        updated_at: '2024-01-20T14:22:00.000Z',
      });
      expect(creditsRepository.getOrCreateByUserId).toHaveBeenCalledTimes(1);
      expect(creditsRepository.getOrCreateByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('returns zero balance for a freshly created credits record', async () => {
      (creditsRepository.getOrCreateByUserId as jest.Mock).mockResolvedValue({
        ...mockCredit(),
        balance_usdc: '0.00',
      });

      const res = await request(app)
        .get('/api/credits')
        .set('Authorization', `Bearer ${generateToken(TEST_USER_ID)}`);

      expect(res.status).toBe(200);
      expect(res.body.balance_usdc).toBe('0.00');
    });
  });

  describe('input validation', () => {
    it('rejects unexpected query parameters with 400', async () => {
      const res = await request(app)
        .get('/api/credits?unexpected=1')
        .set('Authorization', `Bearer ${generateToken(TEST_USER_ID)}`);

      expect(res.status).toBe(400);
      expect(creditsRepository.getOrCreateByUserId).not.toHaveBeenCalled();
    });
  });

  describe('correlation IDs', () => {
    it('propagates x-request-id through the request pipeline', async () => {
      (creditsRepository.getOrCreateByUserId as jest.Mock).mockResolvedValue(mockCredit());

      const res = await request(app)
        .get('/api/credits')
        .set('Authorization', `Bearer ${generateToken(TEST_USER_ID)}`)
        .set('x-request-id', 'corr-credits-882');

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe('corr-credits-882');
    });
  });

  describe('error handling', () => {
    it('forwards repository failures to the error handler', async () => {
      (creditsRepository.getOrCreateByUserId as jest.Mock).mockRejectedValue(
        new Error('db unavailable'),
      );

      const res = await request(app)
        .get('/api/credits')
        .set('Authorization', `Bearer ${generateToken(TEST_USER_ID)}`);

      expect(res.status).toBeGreaterThanOrEqual(500);
    });
  });
});
