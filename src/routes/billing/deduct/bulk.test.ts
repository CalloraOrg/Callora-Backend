import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../../middleware/errorHandler.js';
import bulkRouter from './bulk.js';
import { BillingService } from '../../../services/billing.js';
import type { Pool } from 'pg';

jest.mock('../../../middleware/requireAuth.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userId = req.header('x-user-id');
    if (userId) {
      res.locals.authenticatedUser = { id: userId };
      next();
    } else {
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }
  },
}));

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

describe('Bulk Deduct API', () => {
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      connect: jest.fn(),
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp(pool: Pool | null = mockPool, service?: BillingService) {
    const app = express();
    app.use(express.json());
    if (pool) {
      app.locals.dbPool = pool;
      app.locals.billingService = service ?? new BillingService(pool, {
        getBalance: jest.fn(),
        deductBalance: jest.fn(),
      });
    }

    app.use('/api/billing/deduct/bulk', bulkRouter);
    app.use(errorHandler);
    return app;
  }

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .send({ items: [] });
    
    expect(res.status).toBe(401);
  });

  it('returns 400 for empty items array', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].message).toContain('At least one item is required');
  });

  it('returns 400 when items array exceeds 100 limit', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      requestId: `req_${i}`,
      apiId: 'api_1',
      endpointId: 'ep_1',
      apiKeyId: 'key_1',
      amountUsdc: '1.0',
    }));

    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({ items });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].message).toContain('Batch size limit of 100 items exceeded');
  });

  it('rejects duplicate requestIds in a batch', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({ items: [
        { requestId: 'same', apiId: 'api_1', endpointId: 'ep_1', apiKeyId: 'key_1', amountUsdc: '1' },
        { requestId: 'same', apiId: 'api_1', endpointId: 'ep_2', apiKeyId: 'key_1', amountUsdc: '1' },
      ] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_REQUEST_ID');
  });

  it('returns 400 for invalid item fields (negative amount)', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({
        items: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '-1.0',
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].message).toContain('amountUsdc must be a positive decimal');
  });

  it('returns 400 for invalid item fields (zero amount)', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({
        items: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '0.0',
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].message).toContain('amountUsdc must be greater than zero');
  });

  it('routes the batch through deductBulk and returns aggregate results', async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as never);
    const deductBulkSpy = jest.spyOn(BillingService.prototype, 'deductBulk').mockResolvedValue({
      success: true,
      entryCount: 2,
      deductedCount: 2,
      totalDeductedAmountUsdc: '1.75',
      stellarTxHash: 'tx_batch',
      results: [1, 2].map((index) => ({
        requestId: `req_${index}`,
        usageEventId: `evt_req_${index}`,
        stellarTxHash: 'tx_batch',
        alreadyProcessed: false,
        deductionApplied: true,
        reconciliationRequired: false,
      })),
    });

    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .set('Idempotency-Key', 'batch-key-1')
      .send({
        items: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '0.5',
          },
          {
            requestId: 'req_2',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '1.25',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual({
      requestId: 'req_1',
      success: true,
      usageEventId: 'evt_req_1',
      stellarTxHash: 'tx_batch',
      alreadyProcessed: false,
      deductionApplied: true,
      reconciliationRequired: false,
    });
    expect(res.body.results[1]).toEqual({
      requestId: 'req_2',
      success: true,
      usageEventId: 'evt_req_2',
      stellarTxHash: 'tx_batch',
      alreadyProcessed: false,
      deductionApplied: true,
      reconciliationRequired: false,
    });
    expect(res.body.entryCount).toBe(2);
    expect(res.body.deductedCount).toBe(2);
    expect(res.body.totalDeductedAmountUsdc).toBe('1.75');
    expect(deductBulkSpy).toHaveBeenCalledTimes(1);
    expect(deductBulkSpy.mock.calls[0][1]).toBe('batch-key-1');
  });

  it('returns 402 when the aggregate balance check fails without partial results', async () => {
    const deductBulkSpy = jest.spyOn(BillingService.prototype, 'deductBulk').mockResolvedValue({
      success: false,
      results: [],
      entryCount: 2,
      deductedCount: 0,
      totalDeductedAmountUsdc: '1.5',
      error: 'Insufficient balance: required 15000000 units, available 0',
    });

    const res = await request(buildApp())
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({
        items: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '500.0',
          },
          {
            requestId: 'req_2',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '1.0',
          },
        ],
      });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(deductBulkSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses an injected service across bulk requests', async () => {
    const fakeService = {
      deductBulk: jest.fn().mockResolvedValue({
        success: true,
        entryCount: 1,
        deductedCount: 1,
        totalDeductedAmountUsdc: '1',
        results: [{ requestId: 'req_1', usageEventId: 'evt_1', stellarTxHash: 'tx_1', alreadyProcessed: false, deductionApplied: true, reconciliationRequired: false }],
      }),
    };
    const app = buildApp(mockPool, fakeService as unknown as BillingService);
    const payload = {
      items: [{
        requestId: 'req_1',
        apiId: 'api_1',
        endpointId: 'ep_1',
        apiKeyId: 'key_1',
        amountUsdc: '1.0',
      }],
    };

    for (let index = 0; index < 2; index += 1) {
      const res = await request(app)
        .post('/api/billing/deduct/bulk')
        .set('x-user-id', 'user_123')
        .send(payload);
      expect(res.status).toBe(200);
    }

    expect(fakeService.deductBulk).toHaveBeenCalledTimes(2);
    expect(app.locals.billingService).toBe(fakeService);
  });

  it('returns 500 when database pool is not configured', async () => {
    const res = await request(buildApp(null))
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({
        items: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '1.0',
          },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('Database pool is not configured');
  });
});
