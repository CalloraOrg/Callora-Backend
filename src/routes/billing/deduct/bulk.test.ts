import express from 'express';
import type { Application } from 'express';
import request from 'supertest';

import { errorHandler } from '../../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../../middleware/requestId.js';
import { createBulkDeductRouter } from './bulk.js';

const mockBillingService = {
  deductBulk: jest.fn(),
};

jest.mock('../../../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    audit: jest.fn(),
  },
  getRequestId: jest.fn(),
  runWithRequestContext: jest.fn((_, callback) => callback()),
}));

describe('POST /api/billing/deduct/bulk', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.locals.dbPool = {};
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use(
      '/api/billing/deduct',
      createBulkDeductRouter({
        createBillingService: () => mockBillingService,
      }),
    );
    app.use(errorHandler);
  });

  it('returns 401 without authentication', async () => {
    const response = await request(app)
      .post('/api/billing/deduct/bulk')
      .send({
        entries: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '0.1',
          },
        ],
      });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'UNAUTHORIZED',
      requestId: expect.any(String),
    });
  });

  it('returns a standardized validation error when more than 100 entries are submitted', async () => {
    const entries = Array.from({ length: 101 }, (_, index) => ({
      requestId: `req_${index}`,
      apiId: 'api_1',
      endpointId: 'ep_1',
      apiKeyId: 'key_1',
      amountUsdc: '0.01',
    }));

    const response = await request(app)
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .set('x-request-id', 'bulk-validation-request')
      .send({ entries });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      requestId: 'bulk-validation-request',
    });
    expect(response.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'body.entries',
        }),
      ]),
    );
    expect(mockBillingService.deductBulk).not.toHaveBeenCalled();
  });

  it('rejects duplicate requestId values within the same batch', async () => {
    const response = await request(app)
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send({
        entries: [
          {
            requestId: 'req_duplicate',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '0.01',
          },
          {
            requestId: 'req_duplicate',
            apiId: 'api_2',
            endpointId: 'ep_2',
            apiKeyId: 'key_2',
            amountUsdc: '0.02',
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'body.entries[1].requestId',
          message: 'requestId values must be unique within the batch',
        }),
      ]),
    );
  });

  it('returns 200 with per-entry results and forwards the authenticated user id', async () => {
    mockBillingService.deductBulk.mockResolvedValue({
      success: true,
      entryCount: 2,
      deductedCount: 2,
      totalDeductedAmountUsdc: '0.3',
      stellarTxHash: 'tx_bulk_123',
      results: [
        {
          requestId: 'req_1',
          usageEventId: '101',
          stellarTxHash: 'tx_bulk_123',
          alreadyProcessed: false,
          deductionApplied: true,
          reconciliationRequired: false,
        },
        {
          requestId: 'req_2',
          usageEventId: '102',
          stellarTxHash: 'tx_bulk_123',
          alreadyProcessed: false,
          deductionApplied: true,
          reconciliationRequired: false,
        },
      ],
    });

    const payload = {
      idempotencyKey: 'bulk-key-1',
      entries: [
        {
          requestId: 'req_1',
          apiId: 'api_1',
          endpointId: 'ep_1',
          apiKeyId: 'key_1',
          amountUsdc: '0.1',
        },
        {
          requestId: 'req_2',
          apiId: 'api_2',
          endpointId: 'ep_2',
          apiKeyId: 'key_2',
          amountUsdc: '0.2',
        },
      ],
    };

    const response = await request(app)
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      entryCount: 2,
      deductedCount: 2,
      totalDeductedAmountUsdc: '0.3',
      stellarTxHash: 'tx_bulk_123',
      results: [
        {
          requestId: 'req_1',
          usageEventId: '101',
          stellarTxHash: 'tx_bulk_123',
          alreadyProcessed: false,
          deductionApplied: true,
          reconciliationRequired: false,
        },
        {
          requestId: 'req_2',
          usageEventId: '102',
          stellarTxHash: 'tx_bulk_123',
          alreadyProcessed: false,
          deductionApplied: true,
          reconciliationRequired: false,
        },
      ],
    });

    expect(mockBillingService.deductBulk).toHaveBeenCalledWith(
      [
        {
          requestId: 'req_1',
          userId: 'user_123',
          apiId: 'api_1',
          endpointId: 'ep_1',
          apiKeyId: 'key_1',
          amountUsdc: '0.1',
        },
        {
          requestId: 'req_2',
          userId: 'user_123',
          apiId: 'api_2',
          endpointId: 'ep_2',
          apiKeyId: 'key_2',
          amountUsdc: '0.2',
        },
      ],
      'bulk-key-1',
    );
  });

  it('maps insufficient balance failures to the standard 402 envelope', async () => {
    mockBillingService.deductBulk.mockResolvedValue({
      success: false,
      entryCount: 1,
      deductedCount: 0,
      totalDeductedAmountUsdc: '0.5',
      error: 'Insufficient balance: required 5000000 units, available 1 units',
      results: [],
    });

    const response = await request(app)
      .post('/api/billing/deduct/bulk')
      .set('x-user-id', 'user_123')
      .set('x-request-id', 'bulk-402-request')
      .send({
        entries: [
          {
            requestId: 'req_1',
            apiId: 'api_1',
            endpointId: 'ep_1',
            apiKeyId: 'key_1',
            amountUsdc: '0.5',
          },
        ],
      });

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      code: 'PAYMENT_REQUIRED',
      requestId: 'bulk-402-request',
    });
  });
});
