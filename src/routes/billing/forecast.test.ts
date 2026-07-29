jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn(),
      all: jest.fn(),
      run: jest.fn(),
    }),
    exec: jest.fn(),
    close: jest.fn(),
  }));
});

import express from 'express';
import request from 'supertest';
import billingRouter from '../billing.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';

function buildApp(pool?: { query: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  if (pool) {
    app.locals.dbPool = pool;
  }
  app.use('/api/billing', billingRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/billing/forecast', () => {
  it('returns 401 Unauthorized if user is not authenticated', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/forecast');

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('returns billing forecast with default parameters for authenticated user', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            total_spent: '90.00',
            total_calls: 45,
          },
        ],
      }),
    };

    const app = buildApp(mockPool);
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: 'dev-user-123',
      lookbackDays: 30,
      windowSpentUsdc: '90.0000',
      dailyRunRateUsdc: '3.0000',
      forecastPeriod: 'month',
      forecastDays: 30,
      forecastedAmountUsdc: '90.0000',
      totalCalls: 45,
      currency: 'USDC',
    });
    expect(res.body.lookbackStart).toBeDefined();
    expect(res.body.lookbackEnd).toBeDefined();
    expect(res.body.generatedAt).toBeDefined();
  });

  it('calculates forecast correctly with custom lookbackDays and period', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            total_spent: '70.00',
            total_calls: 14,
          },
        ],
      }),
    };

    const app = buildApp(mockPool);
    const res = await request(app)
      .get('/api/billing/forecast?lookbackDays=7&period=week')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body.lookbackDays).toBe(7);
    expect(res.body.forecastPeriod).toBe('week');
    expect(res.body.forecastDays).toBe(7);
    expect(res.body.windowSpentUsdc).toBe('70.0000');
    expect(res.body.dailyRunRateUsdc).toBe('10.0000');
    expect(res.body.forecastedAmountUsdc).toBe('70.0000');
  });

  it('handles period=day correctly', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            total_spent: '30.00',
            total_calls: 10,
          },
        ],
      }),
    };

    const app = buildApp(mockPool);
    const res = await request(app)
      .get('/api/billing/forecast?lookbackDays=30&period=day')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body.forecastPeriod).toBe('day');
    expect(res.body.forecastDays).toBe(1);
    expect(res.body.dailyRunRateUsdc).toBe('1.0000');
    expect(res.body.forecastedAmountUsdc).toBe('1.0000');
  });

  it('handles period=next_30_days correctly', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            total_spent: '60.00',
            total_calls: 20,
          },
        ],
      }),
    };

    const app = buildApp(mockPool);
    const res = await request(app)
      .get('/api/billing/forecast?period=next_30_days')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body.forecastPeriod).toBe('next_30_days');
    expect(res.body.forecastDays).toBe(30);
    expect(res.body.dailyRunRateUsdc).toBe('2.0000');
    expect(res.body.forecastedAmountUsdc).toBe('60.0000');
  });

  it('handles zero spend/usage gracefully', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            total_spent: '0',
            total_calls: 0,
          },
        ],
      }),
    };

    const app = buildApp(mockPool);
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body.windowSpentUsdc).toBe('0.0000');
    expect(res.body.dailyRunRateUsdc).toBe('0.0000');
    expect(res.body.forecastedAmountUsdc).toBe('0.0000');
    expect(res.body.totalCalls).toBe(0);
  });

  it('handles usage_events query fallback when billing_requests table fails', async () => {
    const mockPool = {
      query: jest.fn()
        .mockRejectedValueOnce(new Error('billing_requests table does not exist'))
        .mockResolvedValueOnce({
          rows: [
            {
              total_spent: '120.00',
              total_calls: 40,
            },
          ],
        }),
    };

    const app = buildApp(mockPool);
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body.dailyRunRateUsdc).toBe('4.0000');
    expect(res.body.forecastedAmountUsdc).toBe('120.0000');
  });

  it('handles no database pool gracefully', async () => {
    const app = buildApp(); // no dbPool in app.locals
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(200);
    expect(res.body.windowSpentUsdc).toBe('0.0000');
    expect(res.body.dailyRunRateUsdc).toBe('0.0000');
    expect(res.body.forecastedAmountUsdc).toBe('0.0000');
  });

  it('rejects invalid lookbackDays (e.g. 0 or > 90 or text)', async () => {
    const app = buildApp();

    const res1 = await request(app)
      .get('/api/billing/forecast?lookbackDays=0')
      .set('x-user-id', 'dev-user-123');
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .get('/api/billing/forecast?lookbackDays=100')
      .set('x-user-id', 'dev-user-123');
    expect(res2.status).toBe(400);

    const res3 = await request(app)
      .get('/api/billing/forecast?lookbackDays=invalid')
      .set('x-user-id', 'dev-user-123');
    expect(res3.status).toBe(400);
  });

  it('rejects invalid period enum', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/billing/forecast?period=invalid_period')
      .set('x-user-id', 'dev-user-123');

    expect(res.status).toBe(400);
  });

  it('supports ETag caching and returns 304 Not Modified when ETag matches', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            total_spent: '60.00',
            total_calls: 20,
          },
        ],
      }),
    };

    // Freeze time so that both requests produce an identical response body (same
    // generatedAt / lookbackStart / lookbackEnd) and therefore the same ETag.
    jest.useFakeTimers({ now: new Date('2025-01-15T12:00:00.000Z') });

    try {
      const app = buildApp(mockPool);

      const res1 = await request(app)
        .get('/api/billing/forecast')
        .set('x-user-id', 'dev-user-123');

      expect(res1.status).toBe(200);
      expect(res1.headers.etag).toBeDefined();

      const etag = res1.headers.etag as string;

      const res2 = await request(app)
        .get('/api/billing/forecast')
        .set('x-user-id', 'dev-user-123')
        .set('If-None-Match', etag);

      expect(res2.status).toBe(304);
    } finally {
      jest.useRealTimers();
    }
  });
});
