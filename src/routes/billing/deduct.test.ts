import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';
import { BillingService, type SorobanClient } from '../../services/billing.js';
import { createSorobanBillingService } from '../../services/createSorobanBillingService.js';
import { env } from '../../config/env.js';

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

describe('POST /api/billing/deduct - developerId validation', () => {
  function buildApp(
    pool: Pool | null = { query: jest.fn() } as unknown as Pool,
    billingService?: BillingService,
  ) {
    const app = express();
    app.use(express.json());
    if (pool) {
      app.locals.dbPool = pool;
      app.locals.billingService = billingService ?? new BillingService(pool, {
        getBalance: jest.fn(),
        deductBalance: jest.fn(),
      });
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

  it('fails clearly when the billing service is not configured', async () => {
    const app = buildApp();
    delete app.locals.billingService;

    const res = await request(app)
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('Billing service is not configured');
  });

  it('uses an injected fake Soroban client across requests without network access', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const fakeClient: jest.Mocked<SorobanClient> = {
      getBalance: jest.fn().mockResolvedValue({ balance: '0' }),
      deductBalance: jest.fn(),
    };
    const service = new BillingService(pool, fakeClient);
    const app = buildApp(pool, service);

    for (const requestId of ['req_first', 'req_second']) {
      const res = await request(app)
        .post('/api/billing/deduct')
        .set('x-user-id', 'user_123')
        .send({ ...validPayload, requestId });
      expect(res.status).toBe(402);
    }

    expect(app.locals.billingService).toBe(service);
    expect(fakeClient.getBalance).toHaveBeenCalledTimes(2);
    expect(fakeClient.deductBalance).not.toHaveBeenCalled();
  });

  it('uses the same injected service for deduction and request lookup', async () => {
    const result = {
      success: true,
      usageEventId: 'evt_1',
      stellarTxHash: 'tx_1',
      alreadyProcessed: false,
    };
    const fakeService = {
      deduct: jest.fn().mockResolvedValue(result),
      getByRequestId: jest.fn().mockResolvedValue(result),
    };
    const app = buildApp(
      { query: jest.fn() } as unknown as Pool,
      fakeService as unknown as BillingService,
    );

    const deducted = await request(app)
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);
    const lookup = await request(app)
      .get('/api/billing/deduct/request/req_1')
      .set('x-user-id', 'user_123');

    expect(deducted.status).toBe(200);
    expect(lookup.status).toBe(200);
    expect(fakeService.deduct).toHaveBeenCalledTimes(1);
    expect(fakeService.getByRequestId).toHaveBeenCalledWith('req_1');
    expect(app.locals.billingService).toBe(fakeService);
  });

  it('creates the billing client only once when the app starts', async () => {
    const fakeClient: jest.Mocked<SorobanClient> = {
      getBalance: jest.fn().mockResolvedValue({ balance: '0' }),
      deductBalance: jest.fn(),
    };
    const createBillingSorobanClient = jest.fn<
      SorobanClient,
      []
    >().mockReturnValue(fakeClient);
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const service = createSorobanBillingService(pool, { createBillingSorobanClient });
    const app = buildApp(pool, service);
    expect(createBillingSorobanClient).toHaveBeenCalledTimes(1);

    for (const requestId of ['req_first', 'req_second']) {
      const res = await request(app)
        .post('/api/billing/deduct')
        .set('x-user-id', 'user_123')
        .send({ ...validPayload, requestId });
      expect(res.status).toBe(402);
    }

    expect(createBillingSorobanClient).toHaveBeenCalledTimes(1);
    expect(fakeClient.getBalance).toHaveBeenCalledTimes(2);
  });

  it('reuses the default billing service across app initializations', () => {
    const previousContractId = env.SOROBAN_BILLING_CONTRACT_ID;
    env.SOROBAN_BILLING_CONTRACT_ID = 'contract_123';
    try {
      const pool = { query: jest.fn() } as unknown as Pool;
      const first = createSorobanBillingService(pool);
      const second = createSorobanBillingService(pool);
      expect(first).toBeInstanceOf(BillingService);
      expect(second).toBe(first);
    } finally {
      env.SOROBAN_BILLING_CONTRACT_ID = previousContractId;
    }
  });
});
