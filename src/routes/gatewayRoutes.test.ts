import express from 'express';
import request from 'supertest';
import { createGatewayRouter } from './gatewayRoutes.js';
import { createRateLimiter } from '../services/rateLimiter.js';

describe('gateway route - rate limiting', () => {
  beforeEach(() => {
    jest.useFakeTimers('modern' as unknown as any);
    jest.setSystemTime(new Date('2026-03-30T00:00:00.000Z').getTime());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns 429 with Retry-After when rate limited', async () => {
    const apiKey = 'test-key';
    const apiId = 'my-api';
    const apiKeys = new Map<string, any>();
    apiKeys.set(apiKey, { key: 'k1', apiId, developerId: 'dev1' });

    const windowMs = 60_000;
    const rateLimiter = createRateLimiter(1, windowMs);
    // exhaust so the route sees a rate-limited result immediately
    rateLimiter.exhaust(apiKey);

    const deps = {
      billing: { deductCredit: async () => ({ success: true, balance: 100 }) },
      rateLimiter,
      usageStore: { record: () => {} },
      upstreamUrl: 'http://example.invalid',
      apiKeys,
    } as any;

    const app = express();
    app.use(express.json());
    app.use('/gateway', createGatewayRouter(deps));

    const res = await request(app).get(`/gateway/${apiId}`).set('x-api-key', apiKey);

    expect(res.status).toBe(429);
    // Retry-After header is in seconds, rounded up
    expect(res.headers['retry-after']).toBe(String(Math.ceil(windowMs / 1000)));
    expect(res.body).toHaveProperty('error', 'Too Many Requests');
    expect(res.body).toHaveProperty('retryAfterMs', windowMs);
    expect(res.body).toHaveProperty('requestId');
  });
});
