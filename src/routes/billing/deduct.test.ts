import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';

jest.mock('better-sqlite3', () => {
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
    const queryMock = jest.fn().mockRejectedValue(new Error('stop before DB write'));
    const res = await request(buildApp({ query: queryMock } as unknown as Pool))
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);

    // Validation passes and the request proceeds past developerId handling
    // (fails later at the DB layer, which is expected given the mocked pool).
    expect(res.status).not.toBe(400);
    expect(queryMock).toHaveBeenCalled();
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe(401);
  });
});
