import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';

jdest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {
      return undefined;
    }
    close() {
      return undefined;
    }
  };
});

jest.mock('../../services/sorobanBilling.js', () => {
  const actual = jest.requireActual('../../services/sorobanBilling.js');
  return {
    ...actual,
    createSorobanRpcBillingClient: jest.fn().mockReturnValue({
      getBalance: jest.fn(),
      deductBalance: jest.fn(),
    }),
  };
});

const mockDeduct = jest.fn();
jest.mock('../../services/billingService.js', () => {
  const actual = jest.requireActual('../../services/billingService.js');
  return {
    ...actual,
    BillingService: jest.fn().implementation(() => ({
      deduct: mockDeduct,
    })),
  };
});

beforeEach(() => {
  mockDeduct.mockReset();
});

describe('POST /api/billing/deduct - developerId validation', () => {
  function buildApp(pool: Pool | null = { query: jest.fn() } as unknown as Pool) {
    const app = express();
    app.use(express.json());
    if (pool) {
      app.locals.dbPool = pool;
    }
    app.use('/api/billing/deduct', deductRouter);
    app.use(errorHandler);
    return app;
  }

  const validPayload = {
    requestId: 'req_1',
    apiId: 'api_1',
    endpointId: 'endpoint_1',
    apiKeyId: 'key_1',
    amountUsdc: '0.01',
  };

  it('returns 400 (not 500) when developerId is explicitly null', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('returns 400 when developerId is an empty string', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('returns 400 when developerId is not a string', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('falls back to the authenticated user id when developerId is omitted', async () => {
    mockDeduct.mockResolved({ success: true });
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(mockDeduct).toHaveBeenCalled();
    const callArg = mockDeduct.mock.calls[0][0] as { userId: string };
    expect(callArg.userId).toBe(user_123');
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe401);
  });

  it('returns 403 when developerId differs from the authenticated user and does not call Soroban', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: 'user_456' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('allows developerId matching the authenticated user', async () => {
    mockDeduct.mockResolved({ success: true });
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: 'user_123' });

    expect(res.status).toBe(200);
    expect(mockDeduct).toHaveBeenCalled();
  });

  it('allows admin to deduct on behalf of another user', async () => {
    mockDeduct.mockResolved({ success: true });
    const result = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ ...validPayload, developerId: 'user_456' });

    expect(result.status).toBe(200);
    expect(mockDeduct).toHaveBeenCalled();
  });
});
