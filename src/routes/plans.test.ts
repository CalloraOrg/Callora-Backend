jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }; }
    exec() { return undefined; }
    close() { return undefined; }
    transaction() { return (fn: () => void) => fn(); }
  };
});

import express from 'express';
import request from 'supertest';
import { createPlansRouter } from './plans.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { InMemoryPlansRepository } from '../repositories/plansRepository.js';
import type { Plan } from '../db/schema.js';

const seedPlans: Plan[] = [
  {
    id: 'plan_starter',
    name: 'Starter',
    description: 'For individuals and small projects',
    priceUsdc: '0',
    requestsPerMonth: 1000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'plan_growth',
    name: 'Growth',
    description: 'For growing teams and businesses',
    priceUsdc: '29.99',
    requestsPerMonth: 10000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'plan_enterprise',
    name: 'Enterprise',
    description: 'For large-scale applications',
    priceUsdc: '99.99',
    requestsPerMonth: 100000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
];

function buildApp(repo?: InMemoryPlansRepository) {
  const app = express();
  app.use('/api/plans', createPlansRouter(5_000, { plansRepository: repo }));
  app.use(errorHandler);
  return app;
}

describe('/api/plans', () => {
  it('should return 200 with list of plans', async () => {
    const repo = new InMemoryPlansRepository(seedPlans);
    const app = buildApp(repo);

    const res = await request(app).get('/api/plans');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it('should return plan by id', async () => {
    const repo = new InMemoryPlansRepository(seedPlans);
    const app = buildApp(repo);

    const res = await request(app).get('/api/plans/plan_starter');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: 'plan_starter',
      name: 'Starter',
      priceUsdc: '0',
    });
  });

  it('should return 404 for unknown plan id', async () => {
    const repo = new InMemoryPlansRepository(seedPlans);
    const app = buildApp(repo);

    const res = await request(app).get('/api/plans/plan_nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 504 when slow endpoint exceeds timeout', async () => {
    const repo = new InMemoryPlansRepository(seedPlans);
    const app = express();
    app.use('/api/plans', createPlansRouter(10, { plansRepository: repo }));
    app.use(errorHandler);

    const res = await request(app).get('/api/plans/slow');
    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
  }, 10_000);

  it('should include requestId in response from requestIdMiddleware', async () => {
    const repo = new InMemoryPlansRepository(seedPlans);
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/plans', createPlansRouter(5_000, { plansRepository: repo }));
    app.use(errorHandler);

    const res = await request(app)
      .get('/api/plans')
      .set('x-request-id', 'test-request-id');
    expect(res.body.requestId).toBe('test-request-id');
  });

  it('should expose plans as sub-route of /api/plans in the router', async () => {
    const repo = new InMemoryPlansRepository(seedPlans);
    const app = buildApp(repo);

    const res = await request(app).get('/api/plans');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  describe('filtering', () => {
    it('should filter plans by priceMin', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?priceMin=10');
      expect(res.status).toBe(200);
      expect(res.body.data.every((p: Plan) => parseFloat(p.priceUsdc) >= 10)).toBe(true);
      expect(res.body.data.length).toBe(2);
    });

    it('should filter plans by priceMax', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?priceMax=50');
      expect(res.status).toBe(200);
      expect(res.body.data.every((p: Plan) => parseFloat(p.priceUsdc) <= 50)).toBe(true);
      expect(res.body.data.length).toBe(2);
    });

    it('should filter plans by priceMin and priceMax', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?priceMin=20&priceMax=50');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    it('should filter plans by minRequests', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?minRequests=5000');
      expect(res.status).toBe(200);
      expect(res.body.data.every((p: Plan) => p.requestsPerMonth >= 5000)).toBe(true);
      expect(res.body.data.length).toBe(2);
    });

    it('should sort plans by price_asc', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?sort=price_asc');
      expect(res.status).toBe(200);
      const prices = res.body.data.map((p: Plan) => parseFloat(p.priceUsdc));
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it('should sort plans by price_desc', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?sort=price_desc');
      expect(res.status).toBe(200);
      const prices = res.body.data.map((p: Plan) => parseFloat(p.priceUsdc));
      expect(prices).toEqual([...prices].sort((a, b) => b - a));
    });

    it('should sort plans by name_asc', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?sort=name_asc');
      expect(res.status).toBe(200);
      const names = res.body.data.map((p: Plan) => p.name);
      expect(names).toEqual([...names].sort());
    });

    it('should sort plans by name_desc', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?sort=name_desc');
      expect(res.status).toBe(200);
      const names = res.body.data.map((p: Plan) => p.name);
      expect(names).toEqual([...names].sort().reverse());
    });

    it('should ignore invalid sort parameter', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?sort=invalid');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(3);
    });

    it('should combine filter and sort', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans?priceMin=10&sort=price_asc');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      const prices = res.body.data.map((p: Plan) => parseFloat(p.priceUsdc));
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });
  });

  describe('InMemoryPlansRepository', () => {
    it('should return empty list when no plans seeded', async () => {
      const repo = new InMemoryPlansRepository();
      const app = buildApp(repo);

      const res = await request(app).get('/api/plans');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should return undefined for unknown id', async () => {
      const repo = new InMemoryPlansRepository(seedPlans);
      const result = await repo.findById('nonexistent');
      expect(result).toBeUndefined();
    });
  });
});
