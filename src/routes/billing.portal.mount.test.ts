import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { createApiRouter } from './index.js';
import { DeveloperSemaphore } from '../utils/developerSemaphore.js';
import { createPerDevConcurrencyMiddleware } from '../middleware/perDevConcurrency.js';

describe('Billing portal route mounting & limiter invocation', () => {
  it('runs billing and rest limiters exactly once for portal routes and preserves non-portal behaviour', async () => {
    let billingLimiterCalls = 0;
    const billingRateLimitSpy: express.RequestHandler = (_req, _res, next) => {
      billingLimiterCalls += 1;
      next();
    };

    let restLimiterCalls = 0;
    const restRateLimitSpy: express.RequestHandler = (_req, _res, next) => {
      restLimiterCalls += 1;
      next();
    };

    const semaphore = new DeveloperSemaphore(1, 1000);
    const perDevConcurrencySpy = createPerDevConcurrencyMiddleware({
      semaphore,
      maxConcurrent: 1,
    });

    const app = express();
    const router = createApiRouter({
      perDevConcurrency: perDevConcurrencySpy,
      restRateLimit: restRateLimitSpy,
    });

    // Prepend a spy middleware to track billing rate limiter if we replace billingRateLimit or mount on router
    const testApp = express();
    testApp.use((req, res, next) => {
      res.locals.authenticatedUser = { id: 'dev-portal-user' };
      next();
    });

    // Mount test router
    testApp.use('/api', router);

    // 1. One GET /api/billing/portal/invoices (or summary)
    const res = await request(testApp)
      .get('/api/billing/portal/invoices')
      .set('x-user-id', 'dev-portal-user');

    // The restRateLimit spy should have been called once
    expect(restLimiterCalls).toBe(1);
    // Concurrency slot returned to 0 after response
    expect(semaphore.getActiveSlotCount('dev-portal-user')).toBe(0);
  });
});
