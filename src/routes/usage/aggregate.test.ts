import express from 'express';
import request from 'supertest';
import { createUsageAggregateRouter } from './aggregate.js';
import {
  InMemoryUsageEventsRepository,
  type UsageEvent,
} from '../../repositories/usageEventsRepository.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const OTHER_USER = 'user-2';

let nextId = 1;
const makeEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: `evt-${nextId++}`,
  developerId: USER_ID,
  apiId: 'api-1',
  endpoint: '/v1/resource',
  userId: USER_ID,
  occurredAt: new Date('2026-07-28T10:30:00.000Z'),
  revenue: 1000n,
  ...overrides,
});

function createTestApp(repo: InMemoryUsageEventsRepository): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/usage/aggregate', createUsageAggregateRouter({ usageEventsRepository: repo }));
  app.use(errorHandler);
  return app;
}

const auth = (req: request.Test): request.Test => req.set('x-user-id', USER_ID);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/usage/aggregate', () => {
  beforeEach(() => { nextId = 1; });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it('requires authentication – returns 401 without credentials', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository([]));
    const res = await request(app).get('/api/usage/aggregate');
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Happy path: basic aggregation
  // -------------------------------------------------------------------------

  it('returns hourly buckets for the authenticated user', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ occurredAt: new Date('2026-07-28T10:05:00.000Z'), revenue: 500n }),
      makeEvent({ occurredAt: new Date('2026-07-28T10:45:00.000Z'), revenue: 1500n }),
      makeEvent({ occurredAt: new Date('2026-07-28T11:20:00.000Z'), revenue: 2000n }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-28T00:00:00.000Z',
        to: '2026-07-29T00:00:00.000Z',
      })
    );

    expect(res.status).toBe(200);

    // Two distinct hours
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toEqual({
      hour: '2026-07-28T10:00:00.000Z',
      calls: 2,
      revenue: '2000',
    });
    expect(res.body.data[1]).toEqual({
      hour: '2026-07-28T11:00:00.000Z',
      calls: 1,
      revenue: '2000',
    });

    // Totals
    expect(res.body.totals).toEqual({ totalCalls: 3, totalRevenue: '4000' });

    // Period echoed back
    expect(res.body.period.from).toBe('2026-07-28T00:00:00.000Z');
    expect(res.body.period.to).toBe('2026-07-29T00:00:00.000Z');
  });

  it('returns an empty data array when there are no events in the window', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ occurredAt: new Date('2026-07-20T10:00:00.000Z') }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-28T00:00:00.000Z',
        to: '2026-07-28T23:59:59.000Z',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.totals).toEqual({ totalCalls: 0, totalRevenue: '0' });
  });

  // -------------------------------------------------------------------------
  // Data isolation
  // -------------------------------------------------------------------------

  it("does not expose another user's data", async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ userId: OTHER_USER, developerId: OTHER_USER }),
      makeEvent({ userId: USER_ID, revenue: 999n }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-31T00:00:00.000Z',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.totals.totalCalls).toBe(1);
    expect(res.body.totals.totalRevenue).toBe('999');
  });

  // -------------------------------------------------------------------------
  // apiId filter
  // -------------------------------------------------------------------------

  it('filters by apiId when supplied', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ apiId: 'api-1', revenue: 100n }),
      makeEvent({ apiId: 'api-2', revenue: 200n }),
      makeEvent({ apiId: 'api-1', revenue: 300n }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-31T00:00:00.000Z',
        apiId: 'api-1',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.totals.totalCalls).toBe(2);
    expect(res.body.totals.totalRevenue).toBe('400');
  });

  // -------------------------------------------------------------------------
  // Default time window (no from/to)
  // -------------------------------------------------------------------------

  it('defaults to the last 24 hours when from and to are omitted', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 h ago (out of window)

    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ occurredAt: recent }),
      makeEvent({ occurredAt: old }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(request(app).get('/api/usage/aggregate'));

    expect(res.status).toBe(200);
    // Only the recent event falls within the default 24-h window
    expect(res.body.totals.totalCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('returns 400 for an invalid "from" date', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository([]));

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({ from: 'not-a-date' })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/from/);
  });

  it('returns 400 for an invalid "to" date', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository([]));

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({ to: 'not-a-date' })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/to/);
  });

  it('returns 400 when "from" is after "to"', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository([]));

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-29T00:00:00.000Z',
        to: '2026-07-28T00:00:00.000Z',
      })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/from.*to|to.*from/i);
  });

  it('accepts equal "from" and "to" timestamps', async () => {
    const ts = '2026-07-28T10:00:00.000Z';
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({ from: ts, to: ts })
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Bucket ordering
  // -------------------------------------------------------------------------

  it('returns buckets in ascending chronological order', async () => {
    // Insert events out of order
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ occurredAt: new Date('2026-07-28T15:00:00.000Z') }),
      makeEvent({ occurredAt: new Date('2026-07-28T09:00:00.000Z') }),
      makeEvent({ occurredAt: new Date('2026-07-28T12:00:00.000Z') }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-28T00:00:00.000Z',
        to: '2026-07-29T00:00:00.000Z',
      })
    );

    expect(res.status).toBe(200);
    const hours = res.body.data.map((b: { hour: string }) => b.hour);
    expect(hours).toEqual([...hours].sort());
  });

  // -------------------------------------------------------------------------
  // Revenue serialisation (bigint → string)
  // -------------------------------------------------------------------------

  it('serialises large revenue values as strings', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ revenue: BigInt('9007199254740992') }), // > Number.MAX_SAFE_INTEGER
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-31T00:00:00.000Z',
      })
    );

    expect(res.status).toBe(200);
    expect(typeof res.body.totals.totalRevenue).toBe('string');
    expect(res.body.totals.totalRevenue).toBe('9007199254740992');
  });

  // -------------------------------------------------------------------------
  // Response shape contract
  // -------------------------------------------------------------------------

  it('always includes data, totals, and period in the response', async () => {
    const repo = new InMemoryUsageEventsRepository([]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-28T00:00:00.000Z',
        to: '2026-07-28T23:59:59.000Z',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('totals');
    expect(res.body.totals).toHaveProperty('totalCalls');
    expect(res.body.totals).toHaveProperty('totalRevenue');
    expect(res.body).toHaveProperty('period');
    expect(res.body.period).toHaveProperty('from');
    expect(res.body.period).toHaveProperty('to');
  });

  it('each bucket has the expected shape', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ occurredAt: new Date('2026-07-28T14:05:00.000Z'), revenue: 250n }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app).get('/api/usage/aggregate').query({
        from: '2026-07-28T00:00:00.000Z',
        to: '2026-07-28T23:59:59.000Z',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const bucket = res.body.data[0];
    expect(typeof bucket.hour).toBe('string');
    expect(typeof bucket.calls).toBe('number');
    expect(typeof bucket.revenue).toBe('string');
    // Hour must be truncated to the hour boundary
    expect(bucket.hour).toBe('2026-07-28T14:00:00.000Z');
  });
});
