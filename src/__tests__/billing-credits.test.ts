import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import creditsRouter, { resetCreditsRateLimit } from '../routes/billing/credits.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { Credit } from '../db/schema.js';

jest.mock('../repositories/creditsRepository.ts', () => ({
  defaultCreditsRepository: {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    updateBalance: jest.fn(),
  },
}));

jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    audit: jest.fn(),
  },
  getRequestId: jest.fn(),
  runWithRequestContext: jest.fn((_: unknown, callback: () => void) => callback()),
}));

import { defaultCreditsRepository } from '../repositories/creditsRepository.js';

const mockCreditsRepository = defaultCreditsRepository as {
  findByUserId: jest.Mock;
  getOrCreateByUserId: jest.Mock;
  updateBalance: jest.Mock;
};

describe('GET /api/billing/credits', () => {
  let app: Application;
  const JWT_SECRET = 'test-secret-key-for-credits-endpoint';
  const TEST_USER_ID = 'test_user_123';

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/billing/credits', creditsRouter);
    app.use(errorHandler);

    jest.clearAllMocks();
    resetCreditsRateLimit();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  function generateToken(userId: string): string {
    return jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  }

  describe('Authentication', () => {
    it('should return 401 when no authorization header is provided', async () => {
      const response = await request(app).get('/api/billing/credits');

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: {
          code: 'UNAUTHORIZED',
          message: expect.any(String),
        },
      });
    });

    it('should return 401 when authorization header is malformed', async () => {
      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', 'InvalidFormat token123');

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: {
          code: 'INVALID_AUTH_HEADER',
        },
      });
    });

    it('should return 401 when JWT token is invalid', async () => {
      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', 'Bearer invalid.jwt.token');

      expect(response.status).toBe(401);
    });

    it('should accept x-user-id header for authentication', async () => {
      const mockCredit: Credit = {
        id: 1,
        user_id: TEST_USER_ID,
        balance_usdc: '50.00',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('x-user-id', TEST_USER_ID);

      expect(response.status).toBe(200);
      expect(mockCreditsRepository.getOrCreateByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    });
  });

  describe('Credits Retrieval', () => {
    it('should return credit balance for existing user', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 1,
        user_id: TEST_USER_ID,
        balance_usdc: '100.50',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-20T14:22:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        user_id: TEST_USER_ID,
        balance_usdc: '100.50',
        created_at: '2024-01-15T10:00:00.000Z',
        updated_at: '2024-01-20T14:22:00.000Z',
      });
      expect(mockCreditsRepository.getOrCreateByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('should create and return zero balance for new user', async () => {
      const token = generateToken('new_user_456');
      const mockCredit: Credit = {
        id: 2,
        user_id: 'new_user_456',
        balance_usdc: '0.00',
        created_at: new Date('2024-01-21T09:00:00Z'),
        updated_at: new Date('2024-01-21T09:00:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        user_id: 'new_user_456',
        balance_usdc: '0.00',
        created_at: '2024-01-21T09:00:00.000Z',
        updated_at: '2024-01-21T09:00:00.000Z',
      });
      expect(mockCreditsRepository.getOrCreateByUserId).toHaveBeenCalledWith('new_user_456');
    });

    it('should handle decimal precision correctly', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 3,
        user_id: TEST_USER_ID,
        balance_usdc: '0.0000001',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.balance_usdc).toBe('0.0000001');
    });

    it('should handle large balance amounts', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 4,
        user_id: TEST_USER_ID,
        balance_usdc: '999999.9999999',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.balance_usdc).toBe('999999.9999999');
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when repository throws an error', async () => {
      const token = generateToken(TEST_USER_ID);
      mockCreditsRepository.getOrCreateByUserId.mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
        },
      });
    });

    it('should reject requests with query parameters', async () => {
      const token = generateToken(TEST_USER_ID);

      const response = await request(app)
        .get('/api/billing/credits?invalid=param')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
        },
      });
    });

    it('should handle missing timestamps gracefully', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 5,
        user_id: TEST_USER_ID,
        balance_usdc: '25.00',
        created_at: null as unknown as Date,
        updated_at: null as unknown as Date,
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.user_id).toBe(TEST_USER_ID);
      expect(response.body.balance_usdc).toBe('25.00');
      expect(response.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(response.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('Concurrency and Idempotency', () => {
    it('should handle concurrent requests for same user', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 6,
        user_id: TEST_USER_ID,
        balance_usdc: '75.25',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const requests = [
        request(app).get('/api/billing/credits').set('Authorization', `Bearer ${token}`),
        request(app).get('/api/billing/credits').set('Authorization', `Bearer ${token}`),
        request(app).get('/api/billing/credits').set('Authorization', `Bearer ${token}`),
      ];

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.balance_usdc).toBe('75.25');
      });

      expect(mockCreditsRepository.getOrCreateByUserId).toHaveBeenCalledTimes(3);
    });
  });

  describe('Rate Limiting', () => {
    it('should allow requests within burst capacity', async () => {
      const mockCredit: Credit = {
        id: 10,
        user_id: TEST_USER_ID,
        balance_usdc: '50.00',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };
      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app)
            .get('/api/billing/credits')
            .set('Authorization', `Bearer ${generateToken(TEST_USER_ID)}`),
        ),
      );

      responses.forEach((response) => {
        expect(response.status).toBe(200);
      });
    });

    it('should return 429 when burst capacity is exceeded', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 11,
        user_id: TEST_USER_ID,
        balance_usdc: '50.00',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };
      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const promises = Array.from({ length: 12 }, () =>
        request(app)
          .get('/api/billing/credits')
          .set('Authorization', `Bearer ${token}`),
      );
      const responses = await Promise.all(promises);

      const successCount = responses.filter((r) => r.status === 200).length;
      const rateLimitCount = responses.filter((r) => r.status === 429).length;

      expect(successCount).toBe(10);
      expect(rateLimitCount).toBe(2);
    });

    it('should return Retry-After header on rate limit', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 12,
        user_id: TEST_USER_ID,
        balance_usdc: '50.00',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };
      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const promises = Array.from({ length: 11 }, () =>
        request(app)
          .get('/api/billing/credits')
          .set('Authorization', `Bearer ${token}`),
      );
      const responses = await Promise.all(promises);
      const rateLimitedResponse = responses.find((r) => r.status === 429);

      expect(rateLimitedResponse).toBeDefined();
      expect(rateLimitedResponse!.headers['retry-after']).toBeDefined();
      expect(rateLimitedResponse!.body.code).toBe('TOO_MANY_REQUESTS');
      expect(rateLimitedResponse!.body.retryAfterMs).toBeGreaterThan(0);
    });

    it('should track rate limits separately per user', async () => {
      const mockCredit: Credit = {
        id: 13,
        user_id: 'any_user',
        balance_usdc: '50.00',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };
      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const tokenA = generateToken('user-A');
      const tokenB = generateToken('user-B');

      const requestsA = Array.from({ length: 10 }, () =>
        request(app).get('/api/billing/credits').set('Authorization', `Bearer ${tokenA}`),
      );
      const requestsB = Array.from({ length: 10 }, () =>
        request(app).get('/api/billing/credits').set('Authorization', `Bearer ${tokenB}`),
      );

      const responsesA = await Promise.all(requestsA);
      const responsesB = await Promise.all(requestsB);

      responsesA.forEach((r) => expect(r.status).toBe(200));
      responsesB.forEach((r) => expect(r.status).toBe(200));
    });
  });

  describe('Response Format', () => {
    it('should return response with correct structure', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 7,
        user_id: TEST_USER_ID,
        balance_usdc: '42.00',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual([
        'balance_usdc',
        'created_at',
        'updated_at',
        'user_id',
      ].sort());
    });

    it('should return timestamps in ISO 8601 format', async () => {
      const token = generateToken(TEST_USER_ID);
      const mockCredit: Credit = {
        id: 8,
        user_id: TEST_USER_ID,
        balance_usdc: '10.00',
        created_at: new Date('2024-01-15T10:30:45.123Z'),
        updated_at: new Date('2024-01-20T14:22:33.456Z'),
      };

      mockCreditsRepository.getOrCreateByUserId.mockResolvedValue(mockCredit);

      const response = await request(app)
        .get('/api/billing/credits')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(response.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
