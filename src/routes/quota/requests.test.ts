import request from 'supertest';
import express from 'express';
import quotaRequestsRouter from './requests.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { setQuotaRequestStore, getQuotaRequestStore } from '../../services/quotaService.js';
import { InMemoryQuotaRequestStore } from '../../services/quotaService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/quota/requests', quotaRequestsRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/quota/requests', () => {
  beforeEach(() => {
    setQuotaRequestStore(new InMemoryQuotaRequestStore());
  });

  it('returns 201 with the created request for valid input', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({
        requested_tier: 'pro',
        reason: 'Need higher rate limits for production workload',
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(expect.objectContaining({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Need higher rate limits for production workload',
      status: 'pending',
    }));
    expect(response.body.data.id).toBeDefined();
    expect(response.body.data.createdAt).toBeDefined();
  });

  it('returns 201 with optional overrides', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({
        requested_tier: 'enterprise',
        reason: 'Running large-scale production APIs that need higher monthly limits',
        requested_overrides: {
          monthly_call_limit: 500000,
          rate_limit_max_requests: 10000,
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.data.requestedOverrides).toEqual({
      monthlyCallLimit: 500000,
      rateLimitMaxRequests: 10000,
    });
  });

  it('returns 400 for missing required fields', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid requested_tier', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({
        requested_tier: 'ultra',
        reason: 'Need ultra tier for high traffic',
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for reason that is too short', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({
        requested_tier: 'pro',
        reason: 'Short',
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 when no auth header is provided', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/quota/requests')
      .send({
        requested_tier: 'pro',
        reason: 'Need higher rate limits for production workload',
      });

    expect(response.status).toBe(401);
  });

  it('stores the request in the service store', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-42')
      .send({
        requested_tier: 'free',
        reason: 'Testing that the request is persisted in the store',
      });

    const store = getQuotaRequestStore();
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].developerId).toBe('dev-42');
  });
});
