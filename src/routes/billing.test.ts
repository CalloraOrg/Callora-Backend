import express from 'express';
import request from 'supertest';
import billingRouter from './billing.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { InMemoryUsageEventsRepository, type UsageEvent } from '../repositories/usageEventsRepository.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

// Contract-unit fixture: the route reads `amount`, `requestId`, `apiKeyId` and
// `createdAt` from the repository row; `revenue` is required by UsageEvent.
type ChargeFixture = UsageEvent & {
  createdAt: Date;
  amount: bigint;
  requestId: string;
  apiKeyId: string;
};

function charge(
  id: string,
  userId: string,
  createdAt: string,
  amount: bigint,
  stellarTxHash: string | null = null,
): ChargeFixture {
  const occurredAt = new Date(createdAt);
  return {
    id,
    developerId: 'dev-1',
    apiId: 'api-1',
    endpoint: 'endpoint-1',
    userId,
    occurredAt,
    createdAt: occurredAt,
    revenue: amount,
    amount,
    requestId: `request-${id}`,
    apiKeyId: 'key-1',
    stellarTxHash,
  };
}

// Amounts are 7-decimal USDC contract units: 12345n = 0.0012345 USDC.
function seedCharges(): ChargeFixture[] {
  return [
    charge('1', 'dev-1', '2024-01-01T00:00:00.000Z', 12345n),
    charge('2', 'dev-1', '2024-01-02T00:00:00.000Z', 40000000n, 'hash-2'),
    charge('3', 'dev-1', '2024-01-03T00:00:00.000Z', 10000000n, 'hash-3'),
    charge('4', 'dev-2', '2024-01-04T00:00:00.000Z', 1n, 'hash-4'),
  ];
}

// The same array is held by the repository, so tests can mutate state between
// real HTTP requests and the handler reads the current rows.
function buildApp(events: ChargeFixture[]) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.locals.usageEventsRepository = new InMemoryUsageEventsRepository(events);
  app.use('/api/billing', billingRouter);
  app.use(errorHandler);
  return app;
}

const bearer = (userId = 'dev-1') => `Bearer ${signTestToken({ userId })}`;

describe('GET /api/billing', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it('returns the newest page of the authenticated consumer charges', async () => {
    const app = buildApp(seedCharges());
    const res = await request(app)
      .get('/api/billing?limit=2')
      .set('Authorization', bearer('dev-1'));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.data.map((row: { id: string }) => row.id)).toEqual(['3', '2']);
    expect(res.body.data.data[0]).toEqual({
      id: '3',
      userId: 'dev-1',
      apiId: 'api-1',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      requestId: 'request-3',
      amountUsdc: '1.0000000',
      stellarTxHash: 'hash-3',
      status: 'confirmed',
      createdAt: '2024-01-03T00:00:00.000Z',
    });
    expect(res.body.data.meta).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
  });

  it('continues from the opaque cursor returned by the previous page', async () => {
    const app = buildApp(seedCharges());
    const first = await request(app)
      .get('/api/billing?limit=2')
      .set('Authorization', bearer('dev-1'));
    expect(first.status).toBe(200);
    const nextCursor: string = first.body.data.meta.nextCursor;

    const res = await request(app)
      .get(`/api/billing?limit=2&cursor=${encodeURIComponent(nextCursor)}`)
      .set('Authorization', bearer('dev-1'));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([
      expect.objectContaining({
        id: '1',
        amountUsdc: '0.0012345',
        stellarTxHash: null,
        status: 'pending',
      }),
    ]);
    expect(res.body.data.meta).toEqual({ limit: 2, hasMore: false, nextCursor: null });
  });

  it('rejects an invalid cursor', async () => {
    const app = buildApp([]);
    const res = await request(app)
      .get('/api/billing?cursor=invalid-cursor')
      .set('Authorization', bearer('dev-1'));

    expect(res.status).toBe(400);
  });

  it('ignores x-user-id when no verified JWT is presented', async () => {
    const app = buildApp(seedCharges());
    const res = await request(app)
      .get('/api/billing')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(401);
  });

  describe('conditional requests', () => {
    it('returns 304 for an unchanged page across two real requests with fresh request IDs', async () => {
      const app = buildApp(seedCharges());

      const res1 = await request(app)
        .get('/api/billing?limit=2')
        .set('Authorization', bearer('dev-1'));
      expect(res1.status).toBe(200);
      expect(res1.headers.etag.startsWith('W/')).toBe(true);

      const res2 = await request(app)
        .get('/api/billing?limit=2')
        .set('Authorization', bearer('dev-1'))
        .set('If-None-Match', res1.headers.etag);

      expect(res2.headers['x-request-id']).not.toBe(res1.headers['x-request-id']);
      expect(res2.status).toBe(304);
      expect(res2.body).toEqual({});
    });

    it('returns 200 with a new ETag when a new charge changes the first page', async () => {
      const events = seedCharges();
      const app = buildApp(events);

      const res1 = await request(app)
        .get('/api/billing?limit=2')
        .set('Authorization', bearer('dev-1'));
      expect(res1.status).toBe(200);

      events.push(charge('5', 'dev-1', '2024-01-05T00:00:00.000Z', 5000000n));

      const res2 = await request(app)
        .get('/api/billing?limit=2')
        .set('Authorization', bearer('dev-1'))
        .set('If-None-Match', res1.headers.etag);

      expect(res2.status).toBe(200);
      expect(res2.headers.etag).not.toBe(res1.headers.etag);
      expect(res2.body.data.data[0].id).toBe('5');
    });

    it('returns 200 when an existing row changes status without changing ordering', async () => {
      const events = seedCharges();
      const app = buildApp(events);

      const res1 = await request(app)
        .get('/api/billing?limit=2')
        .set('Authorization', bearer('dev-1'));
      expect(res1.status).toBe(200);

      // Row '2' is on the first page; confirming it changes stellarTxHash/status.
      const row2 = events.find((e) => e.id === '2');
      expect(row2).toBeDefined();
      row2!.stellarTxHash = null;

      const res2 = await request(app)
        .get('/api/billing?limit=2')
        .set('Authorization', bearer('dev-1'))
        .set('If-None-Match', res1.headers.etag);

      expect(res2.status).toBe(200);
      expect(res2.headers.etag).not.toBe(res1.headers.etag);
      expect(res2.body.data.data[1]).toEqual(
        expect.objectContaining({ id: '2', status: 'pending', stellarTxHash: null }),
      );
    });
  });
});
