import express from 'express';
import request from 'supertest';
import { createPlansRouter } from './plans.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

describe('/api/plans', () => {
  it('should return 200 with list of plans', async () => {
    const app = express();
    app.use('/api/plans', createPlansRouter(5_000));
    app.use(errorHandler);

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
    const app = express();
    app.use('/api/plans', createPlansRouter(5_000));
    app.use(errorHandler);

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
    const app = express();
    app.use('/api/plans', createPlansRouter(5_000));
    app.use(errorHandler);

    const res = await request(app).get('/api/plans/plan_nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 504 when slow endpoint exceeds timeout', async () => {
    const app = express();
    app.use('/api/plans', createPlansRouter(10));
    app.use(errorHandler);

    const res = await request(app).get('/api/plans/slow');
    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
  }, 10_000);

  it('should include requestId in response from requestIdMiddleware', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/plans', createPlansRouter(5_000));
    app.use(errorHandler);

    const res = await request(app)
      .get('/api/plans')
      .set('x-request-id', 'test-request-id');
    expect(res.body.requestId).toBe('test-request-id');
  });

  it('should expose plans as sub-route of /api/plans in the router', async () => {
    const app = express();
    app.use('/api/plans', createPlansRouter(5_000));
    app.use(errorHandler);

    const res = await request(app).get('/api/plans');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
