import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../../middleware/errorHandler.js';
import bulkRouter from './bulk.js';
import { BillingService } from '../../../services/billing.js';
import type { Pool } from 'pg';

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

// Mock the soroban billing client creator
jest.mock('../../../services/sorobanBilling.js', () => ({
  createSorobanRpcBillingClient: jest.fn().mockReturnValue({
    getBalance: jest.fn(),
    deductBalance: jest.fn(),
  }),
}));

describe('Bulk Deduct API', () => {
  let mockPool: jest.Mocked<Pool>;
  let mockBillingService: jest.Mocked<BillingService>;

  beforeEach(() => {
    mockPool = {
      connect: jest.fn(),
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    mockBillingService = {
      deduct: jest.fn(),
    } as unknown as jest.Mocked<BillingService>;

    // Mock createRouteBillingService internal resolution
    jest.spyOn(BillingService.prototype, 'deduct');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp(pool: Pool | null = mockPool, _service: BillingService = mockBillingService) {
    const app = express();
    app.use(express.json());
    if (pool) {
      app.locals.dbPool = pool;
    }
    
    // Middleware to set mock billing service on the route
    app.use((req, res, next) => {
      // Intercept service creation or assign the mock
      next();
    });

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
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].message).toContain('At least one item is required');
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
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].message).toContain('Batch size limit of 100 items exceeded');
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
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].message).toContain('amountUsdc must be a positive decimal');
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
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].message).toContain('amountUsdc must be greater than zero');
  });

  it('successfully processes multiple deductions sequentially', async () => {
    const deductSpy = jest.spyOn(BillingService.prototype, 'deduct').mockImplementation(async (req) => {
      return {
        success: true,
        usageEventId: `evt_${req.requestId}`,
        stellarTxHash: `tx_${req.requestId}`,
        alreadyProcessed: false,
        deductionApplied: true,
        reconciliationRequired: false,
      };
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
      stellarTxHash: 'tx_req_1',
      alreadyProcessed: false,
    });
    expect(res.body.results[1]).toEqual({
      requestId: 'req_2',
      success: true,
      usageEventId: 'evt_req_2',
      stellarTxHash: 'tx_req_2',
      alreadyProcessed: false,
    });

    expect(deductSpy).toHaveBeenCalledTimes(2);
  });

  it('handles item level failure and continues processing the rest of batch', async () => {
    const deductSpy = jest.spyOn(BillingService.prototype, 'deduct')
      .mockImplementationOnce(async () => {
        return {
          success: false,
          usageEventId: '',
          alreadyProcessed: false,
          deductionApplied: false,
          reconciliationRequired: false,
          error: 'Insufficient balance',
        };
      })
      .mockImplementationOnce(async (req) => {
        return {
          success: true,
          usageEventId: `evt_${req.requestId}`,
          stellarTxHash: `tx_${req.requestId}`,
          alreadyProcessed: false,
          deductionApplied: true,
          reconciliationRequired: false,
        };
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

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual({
      requestId: 'req_1',
      success: false,
      error: 'Insufficient balance',
    });
    expect(res.body.results[1]).toEqual({
      requestId: 'req_2',
      success: true,
      usageEventId: 'evt_req_2',
      stellarTxHash: 'tx_req_2',
      alreadyProcessed: false,
    });

    expect(deductSpy).toHaveBeenCalledTimes(2);
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
    expect(res.body.message).toContain('Database pool is not configured');
  });
});
