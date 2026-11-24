import express from 'express';
import request from 'supertest';
import refundsRouter from './refunds.js';
import { defaultDisputeService } from '../services/disputeService.js';
import { refundsCache } from '../services/refundsCacheWarm.js';
import refundsRouter, * as refundsModule from './refunds.js';
const { getRefundStore, clearRefundStore } = refundsModule as unknown as {
  getRefundStore: () => Map<string, Record<string, unknown>>;
  clearRefundStore: () => void;
};
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/refunds', refundsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/refunds', () => {
  beforeEach(() => {
    refundsCache.clear();
    jest.restoreAllMocks();
  });

  it('returns 200 with empty array when no disputes are refunded', async () => {
    jest.spyOn(defaultDisputeService, 'listAll').mockReturnValue([
      {
        id: 'd1',
        usageEventId: 'e1',
        developerId: 'dev-1',
        reason: 'timeout',
        status: 'OPEN',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await request(createTestApp()).get('/api/refunds');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('returns only disputes with status REFUNDED', async () => {
    const listAllSpy = jest.spyOn(defaultDisputeService, 'listAll').mockReturnValue([
      {
        id: 'd1',
        usageEventId: 'e1',
        developerId: 'dev-1',
        reason: 'downtime',
        status: 'REFUNDED',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'd2',
        usageEventId: 'e2',
        developerId: 'dev-1',
        reason: 'valid charge',
        status: 'UPHELD',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await request(createTestApp()).get('/api/refunds');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('d1');
    expect(res.body.data[0].status).toBe('REFUNDED');
    expect(listAllSpy).toHaveBeenCalledTimes(1);
  });

  it('serves subsequent requests from refundsCache without re-querying defaultDisputeService', async () => {
    const listAllSpy = jest.spyOn(defaultDisputeService, 'listAll').mockReturnValue([
      {
        id: 'd1',
        usageEventId: 'e1',
        developerId: 'dev-1',
        reason: 'downtime',
        status: 'REFUNDED',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const app = createTestApp();
    const first = await request(app).get('/api/refunds');
    const second = await request(app).get('/api/refunds');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(listAllSpy).toHaveBeenCalledTimes(1);
  });

  it('echoes X-Request-Id in the response envelope', async () => {
    jest.spyOn(defaultDisputeService, 'listAll').mockReturnValue([]);

    const res = await request(createTestApp())
      .get('/api/refunds')
      .set('x-request-id', 'req-refund-1');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-refund-1');
    expect(res.body.requestId).toBe('req-refund-1');
  });
});
