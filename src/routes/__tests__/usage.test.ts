import request from 'supertest';
import express from 'express';
import { createUsageRouter } from '../usage.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import type { UsageEventsRepository, UsageEvent, UserUsageEventQuery, UsageStats, UsageBucket } from '../../repositories/usageEventsRepository.js';
import { generateCursor } from '../../lib/pagination.js';
import { encodeCursor } from '../../lib/cursorPagination.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CursorResult {
  events: UsageEvent[];
  nextCursor: string | null;
  prevCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  const now = new Date('2026-07-01T00:00:00.000Z');
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    apiId: 'api-1',
    endpoint: '/v1/test',
    occurredAt: now,
    createdAt: now,
    revenue: 100,
    amount: 100,
    apiKeyId: 'key-1',
    developerId: 'dev-1',
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

function makeStats(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    apiId: 'api-1',
    calls: 10,
    revenue: 1000,
    ...overrides,
  };
}

interface MockUsageRepo extends UsageEventsRepository {
  findByUserIdCursor?: jest.Mock;
}

function makeUsageRepo(overrides: Partial<MockUsageRepo> = {}): MockUsageRepo {
  return {
    findByUser: jest.fn().mockResolvedValue([]),
    findByDeveloper: jest.fn().mockResolvedValue([]),
    developerOwnsApi: jest.fn().mockResolvedValue(true),
    aggregateByDeveloper: jest.fn().mockResolvedValue([]),
    aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    create: jest.fn(),
    ...overrides,
  };
}

function buildApp(usageRepo: MockUsageRepo) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    '/api/usage',
    createUsageRouter({ usageEventsRepository: usageRepo as unknown as UsageEventsRepository }),
  );
  app.use(errorHandler);
  return app;
}

// Build a valid JSON-format cursor for after/before params
function buildJsonCursor(ts: Date, id: string): string {
  return encodeCursor(ts, id);
}

// ---------------------------------------------------------------------------
// Zod schema validation tests
// ---------------------------------------------------------------------------

describe('GET /api/usage — Schema Validation', () => {
  it('returns 400 for limit exceeding 100', async () => {
    const repo = makeUsageRepo();
    const app = buildApp(repo);
    const res = await request(app)
      .get('/api/usage?limit=101')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for limit < 1', async () => {
    const repo = makeUsageRepo();
    const app = buildApp(repo);
    const res = await request(app)
      .get('/api/usage?limit=0')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid groupBy value', async () => {
    const repo = makeUsageRepo();
    const app = buildApp(repo);
    const res = await request(app)
      .get('/api/usage?groupBy=invalid')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
  });

  it('returns 400 when from is after to', async () => {
    const repo = makeUsageRepo();
    const app = buildApp(repo);
    const res = await request(app)
      .get('/api/usage?from=2026-07-10T00:00:00Z&to=2026-07-01T00:00:00Z')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const repo = makeUsageRepo();
    const app = buildApp(repo);
    const res = await request(app).get('/api/usage');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Legacy offset/limit pagination tests
// ---------------------------------------------------------------------------

describe('GET /api/usage — Offset/Limit Pagination', () => {
  it('returns usage events and stats with offset pagination', async () => {
    const events = [makeEvent({ id: 'evt-1' }), makeEvent({ id: 'evt-2' })];
    const stats = {
      totalCalls: 10,
      totalRevenue: 1000,
      breakdownByApi: [makeStats()],
    };
    const repo = makeUsageRepo({
      findByUser: jest.fn().mockResolvedValue(events),
      aggregateByUser: jest.fn().mockResolvedValue(stats),
    });
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/usage?offset=0&limit=10')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.stats.totalCalls).toBe(10);
    expect(res.body.pagination).toMatchObject({ limit: 10, offset: 0 });
  });

  it('returns hasMore=true when result count equals limit', async () => {
    const events = Array.from({ length: 3 }, (_, i) => makeEvent({ id: `evt-${i}` }));
    const repo = makeUsageRepo({
      findByUser: jest.fn().mockResolvedValue(events),
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/usage?offset=0&limit=3')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  it('applies default date range when no from/to provided', async () => {
    const findByUser = jest.fn().mockResolvedValue([]);
    const repo = makeUsageRepo({
      findByUser,
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    await request(app)
      .get('/api/usage?offset=0&limit=10')
      .set('x-user-id', 'user-1');

    const query = findByUser.mock.calls[0][0] as UserUsageEventQuery & { from: Date; to: Date };
    expect(query.from).toBeInstanceOf(Date);
    expect(query.to).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Legacy cursor pagination (single `cursor` param) tests
// ---------------------------------------------------------------------------

describe('GET /api/usage — Legacy Cursor Pagination', () => {
  it('returns usage events with next_cursor when cursor param is used', async () => {
    const events: UsageEvent[] = [
      makeEvent({ id: 'evt-1', createdAt: new Date('2026-07-01T00:00:00Z') }),
      makeEvent({ id: 'evt-2', createdAt: new Date('2026-07-02T00:00:00Z') }),
    ];
    (events as any)._nextCursor = 'bmV4dC1jdXJzb3I=';
    (events as any)._hasMore = true;

    const repo = makeUsageRepo({
      findByUser: jest.fn().mockResolvedValue(events),
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    const cursor = generateCursor('2026-07-01T00:00:00.000Z', 'evt-1');
    const res = await request(app)
      .get(`/api/usage?cursor=${cursor}&limit=2`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.hasMore).toBe(true);
  });

  it('returns 400 for malformed legacy cursor value', async () => {
    const repo = makeUsageRepo();
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/usage?cursor=invalid-base64!!')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// New cursor pagination (after / before params) tests
// ---------------------------------------------------------------------------

describe('GET /api/usage — Cursor Pagination (after/before)', () => {
  it('returns events with nextCursor and prevCursor when using after param', async () => {
    const cursorResult: CursorResult = {
      events: [
        makeEvent({ id: 'evt-1', createdAt: new Date('2026-07-01T00:00:00Z') }),
        makeEvent({ id: 'evt-2', createdAt: new Date('2026-07-02T00:00:00Z') }),
      ],
      nextCursor: 'bmV4dC1jdXJzb3I=',
      prevCursor: null,
    };
    const repo = makeUsageRepo({
      findByUserIdCursor: jest.fn().mockResolvedValue(cursorResult) as jest.Mock,
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    const cursor = buildJsonCursor(new Date('2026-06-30T00:00:00.000Z'), 'evt-0');
    const res = await request(app)
      .get(`/api/usage?after=${encodeURIComponent(cursor)}&limit=2`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({
      nextCursor: 'bmV4dC1jdXJzb3I=',
      prevCursor: null,
      limit: 2,
    });
  });

  it('returns events with prevCursor when using before param', async () => {
    const cursorResult: CursorResult = {
      events: [
        makeEvent({ id: 'evt-1', createdAt: new Date('2026-06-30T00:00:00Z') }),
      ],
      nextCursor: null,
      prevCursor: 'cHJldi1jdXJzb3I=',
    };
    const repo = makeUsageRepo({
      findByUserIdCursor: jest.fn().mockResolvedValue(cursorResult) as jest.Mock,
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    const cursor = buildJsonCursor(new Date('2026-07-02T00:00:00.000Z'), 'evt-3');
    const res = await request(app)
      .get(`/api/usage?before=${encodeURIComponent(cursor)}&limit=1`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.pagination.prevCursor).toBe('cHJldi1jdXJzb3I=');
  });

  it('returns 400 for invalid after cursor value', async () => {
    const repo = makeUsageRepo({
      findByUserIdCursor: jest.fn() as jest.Mock,
    });
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/usage?after=!!!not-valid-base64!!!&limit=2')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('cursor');
  });

  it('returns 400 for invalid before cursor value', async () => {
    const repo = makeUsageRepo({
      findByUserIdCursor: jest.fn() as jest.Mock,
    });
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/usage?before=!!!not-valid-base64!!!&limit=2')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
  });

  it('uses findByUserIdCursor when repository supports it', async () => {
    const cursorResult: CursorResult = {
      events: [makeEvent({ id: 'evt-1' })],
      nextCursor: null,
      prevCursor: null,
    };
    const findByUserIdCursor = jest.fn().mockResolvedValue(cursorResult);
    const repo = makeUsageRepo({
      findByUserIdCursor,
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    const cursor = buildJsonCursor(new Date('2026-06-30T00:00:00.000Z'), 'evt-0');
    const res = await request(app)
      .get(`/api/usage?after=${encodeURIComponent(cursor)}&limit=2`)
      .set('x-user-id', 'user-1');

    // Verify the cursor pagination path ran successfully
    expect(res.status).toBe(200);

    // Verify findByUserIdCursor was called with expected params
    expect(findByUserIdCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        limit: 2,
      }),
    );
  });

  it('falls back to offset pagination when repository does not support findByUserIdCursor', async () => {
    const events = [makeEvent({ id: 'evt-1' })];
    const repo = makeUsageRepo({
      findByUserIdCursor: undefined,
      findByUser: jest.fn().mockResolvedValue(events),
      aggregateByUser: jest.fn().mockResolvedValue({ totalCalls: 0, totalRevenue: 0, breakdownByApi: [] }),
    });
    const app = buildApp(repo);

    // When after/before is provided but findByUserIdCursor is not available,
    // it should fall through to the legacy offset path
    const cursor = buildJsonCursor(new Date('2026-06-30T00:00:00.000Z'), 'evt-0');
    const res = await request(app)
      .get(`/api/usage?after=${encodeURIComponent(cursor)}&limit=2`)
      .set('x-user-id', 'user-1');

    // Should still return a response (fallback)
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});
