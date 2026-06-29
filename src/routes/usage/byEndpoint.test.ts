import express from 'express';
import request from 'supertest';
import { createUsageByEndpointRouter } from './byEndpoint.js';
import {
  InMemoryUsageEventsRepository,
  type UsageEvent,
} from '../../repositories/usageEventsRepository.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';

const USER_ID = 'user-1';

const makeEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'evt-1',
  developerId: USER_ID,
  apiId: 'api-1',
  endpoint: '/v1/resource',
  userId: USER_ID,
  occurredAt: new Date('2026-03-01T10:00:00.000Z'),
  revenue: 1000n,
  ...overrides,
});

function createTestApp(repo: InMemoryUsageEventsRepository): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/usage/by-endpoint', createUsageByEndpointRouter({ usageEventsRepository: repo }));
  app.use(errorHandler);
  return app;
}

const auth = (req: request.Test): request.Test => req.set('x-user-id', USER_ID);

describe('GET /api/usage/by-endpoint', () => {
  it('requires authentication', async () => {
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res = await request(app).get('/api/usage/by-endpoint');
    expect(res.status).toBe(401);
  });

  it('returns top endpoints by call volume', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ endpoint: '/v1/a', occurredAt: new Date('2026-03-01T10:00:00.000Z') }),
      makeEvent({ endpoint: '/v1/a', occurredAt: new Date('2026-03-01T11:00:00.000Z') }),
      makeEvent({ endpoint: '/v1/b', occurredAt: new Date('2026-03-01T10:00:00.000Z') }),
      makeEvent({ endpoint: '/v1/b', occurredAt: new Date('2026-03-01T11:00:00.000Z') }),
      makeEvent({ endpoint: '/v1/b', occurredAt: new Date('2026-03-01T12:00:00.000Z') }),
      makeEvent({ endpoint: '/v1/c', occurredAt: new Date('2026-03-01T10:00:00.000Z') }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({
          from: '2026-03-01T00:00:00.000Z',
          to: '2026-03-02T00:00:00.000Z',
          limit: 2,
        })
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { endpoint: '/v1/b', calls: 3, revenue: '3000' },
      { endpoint: '/v1/a', calls: 2, revenue: '2000' },
    ]);
    expect(res.body.period).toEqual({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-02T00:00:00.000Z',
    });
  });

  it('filters by apiId', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ endpoint: '/v1/a', apiId: 'api-1' }),
      makeEvent({ endpoint: '/v1/a', apiId: 'api-2' }),
      makeEvent({ endpoint: '/v1/b', apiId: 'api-1' }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({
          from: '2026-02-15T00:00:00.000Z',
          to: '2026-03-15T00:00:00.000Z',
          apiId: 'api-1',
        })
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { endpoint: '/v1/a', calls: 1, revenue: '1000' },
      { endpoint: '/v1/b', calls: 1, revenue: '1000' },
    ]);
  });

  it('rejects invalid limit', async () => {
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({ limit: 'invalid' })
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('limit must be a positive integer');
  });

  it('rejects negative limit', async () => {
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({ limit: '-1' })
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('limit must be a positive integer');
  });

  it('rejects invalid dates', async () => {
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res1 = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({ from: 'not-a-date' })
    );
    expect(res1.status).toBe(400);

    const res2 = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({ to: 'not-a-date' })
    );
    expect(res2.status).toBe(400);
  });

  it('rejects from date after to date', async () => {
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app)
        .get('/api/usage/by-endpoint')
        .query({
          from: '2026-03-02T00:00:00.000Z',
          to: '2026-03-01T00:00:00.000Z',
        })
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('from must be before or equal to to');
  });
});
