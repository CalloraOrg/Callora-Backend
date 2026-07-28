process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS = 'https://app.callora.com';

import request from 'supertest';
import express from 'express';
import { createSubscriptionRouter } from './subscriptionRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import type { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { Api, Developer, Subscription } from '../db/schema.js';

const TEST_ORIGIN = 'https://app.callora.com';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date('2026-01-01T00:00:00.000Z');

const subscriberDeveloper: Developer = {
  id: 1,
  user_id: 'user-subscriber',
  name: 'Subscriber Dev',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: now,
  updated_at: now,
};

const ownerDeveloper: Developer = {
  id: 2,
  user_id: 'user-owner',
  name: 'Owner Dev',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: now,
  updated_at: now,
};

const activeApi: Api = {
  id: 10,
  developer_id: 2, // owned by ownerDeveloper
  name: 'Test API',
  description: null,
  base_url: 'https://api.example.com',
  logo_url: null,
  category: 'search',
  status: 'active',
  created_at: now,
  updated_at: now,
  deleted_at: null,
};

const deletedApi: Api = {
  ...activeApi,
  id: 11,
  deleted_at: now,
};

const makeSubscription = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 'sub-001',
  user_id: 'user-subscriber',
  api_id: 10,
  status: 'active',
  metering_limit: null,
  retry_policy: null,
  created_at: now,
  updated_at: now,
  cancelled_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSubscriptionRepo(overrides: Partial<SubscriptionRepository> = {}): SubscriptionRepository {
  return {
    create: jest.fn().mockResolvedValue(makeSubscription()),
    findById: jest.fn().mockResolvedValue(undefined),
    findByUserId: jest.fn().mockResolvedValue([]),
    findActiveByUserAndApi: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(makeSubscription()),
    cancel: jest.fn().mockResolvedValue(makeSubscription({ status: 'cancelled', cancelled_at: now })),
    ...overrides,
  };
}

function makeApiRepo(overrides: Partial<ApiRepository> = {}): ApiRepository {
  return {
    create: jest.fn(),
    createWithEndpoints: jest.fn(),
    update: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(false),
    restore: jest.fn().mockResolvedValue(null),
    listByDeveloper: jest.fn().mockResolvedValue([]),
    listPublic: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    findRawById: jest.fn().mockResolvedValue(activeApi),
    getEndpoints: jest.fn().mockResolvedValue([]),
    bulkCreateEndpoints: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ApiRepository;
}

function makeDeveloperRepo(overrides: Partial<DeveloperRepository> = {}): DeveloperRepository {
  return {
    findByUserId: jest.fn().mockImplementation((userId: string) => {
      if (userId === subscriberDeveloper.user_id) return Promise.resolve(subscriberDeveloper);
      if (userId === ownerDeveloper.user_id) return Promise.resolve(ownerDeveloper);
      return Promise.resolve(undefined);
    }),
    getOrCreateByUserId: jest.fn().mockResolvedValue(subscriberDeveloper),
    upsertProfile: jest.fn().mockResolvedValue(subscriberDeveloper),
    ...overrides,
  };
}

function buildApp(
  subscriptionRepo: SubscriptionRepository,
  apiRepo: ApiRepository,
  developerRepo: DeveloperRepository,
) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    '/api/subscriptions',
    createSubscriptionRouter({
      subscriptionRepository: subscriptionRepo,
      apiRepository: apiRepo,
      developerRepository: developerRepo,
    }),
  );
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// POST /api/subscriptions
// ---------------------------------------------------------------------------

describe('POST /api/subscriptions', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app).post('/api/subscriptions').set('Origin', TEST_ORIGIN).send({ api_id: 10 });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing api_id', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer api_id', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 'bad' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when metering_limit is zero', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, metering_limit: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when api does not exist', async () => {
    const apiRepo = makeApiRepo({ findRawById: jest.fn().mockResolvedValue(null) });
    const app = buildApp(makeSubscriptionRepo(), apiRepo, makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 99 });
    expect(res.status).toBe(404);
  });

  it('returns 404 when api is soft-deleted', async () => {
    const apiRepo = makeApiRepo({ findRawById: jest.fn().mockResolvedValue(deletedApi) });
    const app = buildApp(makeSubscriptionRepo(), apiRepo, makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 11 });
    expect(res.status).toBe(404);
  });

  it('returns 403 when subscribing to own API', async () => {
    // ownerDeveloper (id=2) owns activeApi (developer_id=2)
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-owner') // this user is the owner
      .send({ api_id: 10 });
    expect(res.status).toBe(403);
  });

  it('returns 409 when subscription already exists', async () => {
    const subRepo = makeSubscriptionRepo({
      findActiveByUserAndApi: jest.fn().mockResolvedValue(makeSubscription()),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10 });
    expect(res.status).toBe(409);
  });

  it('creates a subscription and returns 201', async () => {
    const created = makeSubscription({ metering_limit: 500 });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, metering_limit: 500 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(created.id);
    expect(res.body.status).toBe('active');
  });

  it('accepts null metering_limit (unlimited)', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, metering_limit: null });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /api/subscriptions
// ---------------------------------------------------------------------------

describe('GET /api/subscriptions', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app).get('/api/subscriptions').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('returns empty list when user has no subscriptions', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('returns all subscriptions for the user', async () => {
    const subs = [makeSubscription(), makeSubscription({ id: 'sub-002', status: 'paused' })];
    const subRepo = makeSubscriptionRepo({ findByUserId: jest.fn().mockResolvedValue(subs) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('filters by status query param', async () => {
    const subs = [
      makeSubscription({ id: 'sub-a', status: 'active' }),
      makeSubscription({ id: 'sub-b', status: 'paused' }),
      makeSubscription({ id: 'sub-c', status: 'cancelled', cancelled_at: now }),
    ];
    const subRepo = makeSubscriptionRepo({ findByUserId: jest.fn().mockResolvedValue(subs) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions?status=active')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe('sub-a');
  });

  it('returns 400 for invalid status filter', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions?status=invalid')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/subscriptions/:id
// ---------------------------------------------------------------------------

describe('GET /api/subscriptions/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app).get('/api/subscriptions/sub-001').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown subscription', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions/does-not-exist')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(404);
  });

  it('returns 403 when subscription belongs to a different user', async () => {
    const otherUserSub = makeSubscription({ user_id: 'user-other' });
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(otherUserSub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(403);
  });

  it('returns the subscription for the owning user', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .get('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('sub-001');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/subscriptions/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN).send({ status: 'paused' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown subscription', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/does-not-exist')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ status: 'paused' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when subscription belongs to a different user', async () => {
    const otherUserSub = makeSubscription({ user_id: 'user-other' });
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(otherUserSub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ status: 'paused' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when trying to modify a cancelled subscription', async () => {
    const cancelledSub = makeSubscription({ status: 'cancelled', cancelled_at: now });
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(cancelledSub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ status: 'active' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is empty', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when metering_limit is negative', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ metering_limit: -1 });
    expect(res.status).toBe(400);
  });

  it('pauses a subscription', async () => {
    const sub = makeSubscription();
    const paused = makeSubscription({ status: 'paused' });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue(paused),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ status: 'paused' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
  });

  it('updates metering_limit', async () => {
    const sub = makeSubscription();
    const updated = makeSubscription({ metering_limit: 1000 });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue(updated),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ metering_limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.metering_limit).toBe(1000);
  });

  it('clears metering_limit to null', async () => {
    const sub = makeSubscription({ metering_limit: 500 });
    const updated = makeSubscription({ metering_limit: null });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue(updated),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ metering_limit: null });
    expect(res.status).toBe(200);
    expect(res.body.metering_limit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/subscriptions/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/subscriptions/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app).delete('/api/subscriptions/sub-001').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown subscription', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .delete('/api/subscriptions/does-not-exist')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(404);
  });

  it('returns 403 when subscription belongs to a different user', async () => {
    const otherUserSub = makeSubscription({ user_id: 'user-other' });
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(otherUserSub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .delete('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(403);
  });

  it('returns 400 when subscription is already cancelled', async () => {
    const cancelledSub = makeSubscription({ status: 'cancelled', cancelled_at: now });
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(cancelledSub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .delete('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(400);
  });

  it('cancels a subscription and returns cancelled status', async () => {
    const sub = makeSubscription();
    const cancelled = makeSubscription({ status: 'cancelled', cancelled_at: now });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      cancel: jest.fn().mockResolvedValue(cancelled),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());
    const res = await request(app)
      .delete('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelled_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-subscription Webhook Retry Policy Override
// ---------------------------------------------------------------------------

describe('POST /api/subscriptions — retry_policy', () => {
  it('creates a subscription with a valid retry_policy override', async () => {
    const retryPolicy = { maxRetries: 3, baseDelayMs: 500 };
    const created = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: retryPolicy });

    expect(res.status).toBe(201);
    // The repo returns the raw row; retry_policy is persisted as a JSON string in DB
    expect(res.body.retry_policy).toBe(JSON.stringify(retryPolicy));
  });

  it('creates a subscription without retry_policy (uses platform default)', async () => {
    const created = makeSubscription({ retry_policy: null });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10 });

    expect(res.status).toBe(201);
    expect(res.body.retry_policy).toBeNull();
  });

  it('creates a subscription with retry_policy: null (explicitly clear)', async () => {
    const created = makeSubscription({ retry_policy: null });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: null });

    expect(res.status).toBe(201);
    expect(res.body.retry_policy).toBeNull();
  });

  it('returns 400 for invalid maxRetries (above 10)', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { maxRetries: 11 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid maxRetries (below 0)', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { maxRetries: -1 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid baseDelayMs (below 100)', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { baseDelayMs: 99 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid baseDelayMs (above 60000)', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { baseDelayMs: 60001 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer maxRetries', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { maxRetries: 3.5 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer baseDelayMs', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { baseDelayMs: 1000.5 } });

    expect(res.status).toBe(400);
  });

  it('accepts retry_policy with only maxRetries set', async () => {
    const retryPolicy = { maxRetries: 2 };
    const created = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: retryPolicy });

    expect(res.status).toBe(201);
  });

  it('accepts retry_policy with only baseDelayMs set', async () => {
    const retryPolicy = { baseDelayMs: 2000 };
    const created = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: retryPolicy });

    expect(res.status).toBe(201);
  });

  it('accepts maxRetries: 0 (no retries)', async () => {
    const retryPolicy = { maxRetries: 0 };
    const created = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const subRepo = makeSubscriptionRepo({ create: jest.fn().mockResolvedValue(created) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: retryPolicy });

    expect(res.status).toBe(201);
  });

  it('returns 400 for extra unknown fields in retry_policy', async () => {
    const app = buildApp(makeSubscriptionRepo(), makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: { maxRetries: 3, unknownField: 'x' } });

    expect(res.status).toBe(400);
  });

  it('passes retry_policy to repository create', async () => {
    const retryPolicy = { maxRetries: 5, baseDelayMs: 1500 };
    const created = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const createFn = jest.fn().mockResolvedValue(created);
    const subRepo = makeSubscriptionRepo({ create: createFn });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    await request(app)
      .post('/api/subscriptions')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ api_id: 10, retry_policy: retryPolicy });

    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({ retry_policy: retryPolicy }),
    );
  });
});

describe('PATCH /api/subscriptions/:id — retry_policy', () => {
  it('updates the retry_policy on an existing subscription', async () => {
    const sub = makeSubscription();
    const retryPolicy = { maxRetries: 4, baseDelayMs: 800 };
    const updated = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue(updated),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: retryPolicy });

    expect(res.status).toBe(200);
    expect(res.body.retry_policy).toBe(JSON.stringify(retryPolicy));
  });

  it('clears retry_policy to null (revert to platform default)', async () => {
    const sub = makeSubscription({ retry_policy: JSON.stringify({ maxRetries: 3 }) });
    const updated = makeSubscription({ retry_policy: null });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue(updated),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: null });

    expect(res.status).toBe(200);
    expect(res.body.retry_policy).toBeNull();
  });

  it('returns 400 for invalid maxRetries in PATCH body', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: { maxRetries: 15 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid baseDelayMs in PATCH body', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: { baseDelayMs: 50 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer maxRetries in PATCH body', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: { maxRetries: 2.5 } });

    expect(res.status).toBe(400);
  });

  it('passes retry_policy to repository update', async () => {
    const sub = makeSubscription();
    const retryPolicy = { maxRetries: 7, baseDelayMs: 3000 };
    const updated = makeSubscription({ retry_policy: JSON.stringify(retryPolicy) });
    const updateFn = jest.fn().mockResolvedValue(updated);
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: updateFn,
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: retryPolicy });

    expect(updateFn).toHaveBeenCalledWith(
      'sub-001',
      expect.objectContaining({ retry_policy: retryPolicy }),
    );
  });

  it('accepts retry_policy alongside other updates', async () => {
    const sub = makeSubscription();
    const retryPolicy = { maxRetries: 2, baseDelayMs: 200 };
    const updated = makeSubscription({ status: 'paused', retry_policy: JSON.stringify(retryPolicy) });
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue(updated),
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ status: 'paused', retry_policy: retryPolicy });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
    expect(res.body.retry_policy).toBe(JSON.stringify(retryPolicy));
  });

  it('does not touch retry_policy when not present in PATCH body', async () => {
    const storedPolicy = JSON.stringify({ maxRetries: 3 });
    const sub = makeSubscription({ retry_policy: storedPolicy });
    const updated = makeSubscription({ status: 'paused', retry_policy: storedPolicy });
    const updateFn = jest.fn().mockResolvedValue(updated);
    const subRepo = makeSubscriptionRepo({
      findById: jest.fn().mockResolvedValue(sub),
      update: updateFn,
    });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ status: 'paused' });

    // retry_policy should NOT be in the update call (undefined = leave unchanged)
    const updateArg = updateFn.mock.calls[0][1];
    expect(updateArg).not.toHaveProperty('retry_policy');
  });

  it('returns 400 for extra unknown fields in retry_policy on PATCH', async () => {
    const sub = makeSubscription();
    const subRepo = makeSubscriptionRepo({ findById: jest.fn().mockResolvedValue(sub) });
    const app = buildApp(subRepo, makeApiRepo(), makeDeveloperRepo());

    const res = await request(app)
      .patch('/api/subscriptions/sub-001')
      .set('Origin', TEST_ORIGIN)
      .set('x-user-id', 'user-subscriber')
      .send({ retry_policy: { maxRetries: 3, bogus: true } });

    expect(res.status).toBe(400);
  });
});
