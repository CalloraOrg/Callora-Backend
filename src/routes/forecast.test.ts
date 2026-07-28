import request from 'supertest';
import { Express } from 'express';
import express from 'express';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { auditEnrichMiddleware } from '../middleware/auditEnrich.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createForecastRouter } from './forecast.js';
import type { PaginatedForecastResponse, ForecastPoint } from './forecast.js';
import { FORECAST_DEFAULT_LIMIT, FORECAST_MAX_LIMIT } from './forecast.js';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { defaultAuditService } from '../services/auditService.js';
import jwt from 'jsonwebtoken';

// Mock auditService to capture audit calls
jest.mock('../services/auditService.js');
const mockAuditService = defaultAuditService as jest.Mocked<typeof defaultAuditService>;

// Mock JWT to simulate authenticated users
jest.mock('jsonwebtoken');
const mockJwt = jwt as unknown as {
  verify: jest.MockedFunction<typeof jwt.verify>;
};

/**
 * Create a test Express app with the forecast router and all required middleware.
 */
function createTestApp(timeoutMs = 5_000): Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(auditEnrichMiddleware);
  app.use('/api/forecast', createForecastRouter(timeoutMs));
  app.use(errorHandler);
  return app;
}

/**
 * Create a valid JWT token for testing authenticated requests.
 */
function createToken(userId: string): string {
  return `mock-token-${userId}`;
}

/**
 * Decode a base64url cursor and verify it is a valid fc:<index> string.
 * Returns the integer index or throws.
 */
function decodeCursorIndex(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
  const match = /^fc:(\d+)$/.exec(decoded);
  if (!match) throw new Error(`Unexpected cursor format: ${decoded}`);
  return parseInt(match[1], 10);
}

// ===========================================================================
// Shared app setup
// ===========================================================================

let app: Express;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuditService.record.mockResolvedValue(undefined);

  mockJwt.verify = jest.fn().mockImplementation((token: string) => {
    const userId = (token as string).replace('mock-token-', '');
    return { userId, sub: userId };
  });

  process.env.JWT_SECRET = 'test-secret-key';
  app = createTestApp();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// GET /api/forecast — Pagination: shape assertions
// ===========================================================================

describe('GET /api/forecast — paginated envelope shape', () => {
  it('returns 200 with the {items, total} envelope (no next_cursor on first/only page when all fit)', async () => {
    // The route generates 24 hourly points. With default limit=20, the first
    // page has 20 items and a next_cursor; requesting limit=100 fits them all.
    const res = await request(app).get('/api/forecast?limit=100');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data: PaginatedForecastResponse = res.body.data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(data.total).toBe(24); // 24 hourly forecast points generated
    expect(data.items).toHaveLength(24);
    // All items fit in one page → no next_cursor
    expect(data.next_cursor).toBeUndefined();
  });

  it('includes requestId and timestamp in the outer envelope', async () => {
    const res = await request(app)
      .get('/api/forecast')
      .set('X-Request-Id', 'req-test-001');

    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe('req-test-001');
    expect(res.body.timestamp).toBeDefined();
    expect(new Date(res.body.timestamp as string).getTime()).not.toBeNaN();
  });

  it('each item has timestamp (ISO string) and value (number)', async () => {
    const res = await request(app).get('/api/forecast?limit=100');

    expect(res.status).toBe(200);
    const items: ForecastPoint[] = res.body.data.items;
    for (const point of items) {
      expect(typeof point.timestamp).toBe('string');
      expect(new Date(point.timestamp).getTime()).not.toBeNaN();
      expect(typeof point.value).toBe('number');
      expect(point.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('does NOT include next_cursor when all items fit on one page', async () => {
    const res = await request(app).get('/api/forecast?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.next_cursor).toBeUndefined();
  });

  it('total always equals 24 regardless of the page size', async () => {
    const res1 = await request(app).get('/api/forecast?limit=5');
    const res2 = await request(app).get('/api/forecast?limit=100');

    expect(res1.body.data.total).toBe(24);
    expect(res2.body.data.total).toBe(24);
  });
});

// ===========================================================================
// GET /api/forecast — Pagination: default page (no params)
// ===========================================================================

describe('GET /api/forecast — default page (limit=20)', () => {
  it('returns 20 items when no limit is specified', async () => {
    const res = await request(app).get('/api/forecast');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(FORECAST_DEFAULT_LIMIT);
  });

  it('returns a next_cursor when the dataset is larger than the default limit', async () => {
    // Dataset is 24 points, default limit is 20 → page 1 has a cursor.
    const res = await request(app).get('/api/forecast');

    expect(res.status).toBe(200);
    expect(res.body.data.next_cursor).toBeDefined();
    expect(typeof res.body.data.next_cursor).toBe('string');
  });

  it('next_cursor encodes index 20 after default page', async () => {
    const res = await request(app).get('/api/forecast');
    const idx = decodeCursorIndex(res.body.data.next_cursor as string);
    expect(idx).toBe(20);
  });
});

// ===========================================================================
// GET /api/forecast — Pagination: explicit limit values
// ===========================================================================

describe('GET /api/forecast — explicit limit', () => {
  it('honours limit=5 and returns 5 items with a next_cursor', async () => {
    const res = await request(app).get('/api/forecast?limit=5');

    expect(res.status).toBe(200);
    const data: PaginatedForecastResponse = res.body.data;
    expect(data.items).toHaveLength(5);
    expect(data.next_cursor).toBeDefined();
    const idx = decodeCursorIndex(data.next_cursor as string);
    expect(idx).toBe(5);
  });

  it('clamps limit to FORECAST_MAX_LIMIT (100) even when client sends a higher value', async () => {
    const res = await request(app).get('/api/forecast?limit=999');

    expect(res.status).toBe(200);
    // Dataset only has 24, so all fit; items length ≤ FORECAST_MAX_LIMIT
    expect(res.body.data.items.length).toBeLessThanOrEqual(FORECAST_MAX_LIMIT);
  });

  it('returns a full page when limit equals the dataset size', async () => {
    const res = await request(app).get('/api/forecast?limit=24');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(24);
    expect(res.body.data.next_cursor).toBeUndefined();
  });

  it('limit=1 returns exactly 1 item with a next_cursor pointing to index 1', async () => {
    const res = await request(app).get('/api/forecast?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.next_cursor).toBeDefined();
    expect(decodeCursorIndex(res.body.data.next_cursor as string)).toBe(1);
  });
});

// ===========================================================================
// GET /api/forecast — Pagination: cursor-based traversal
// ===========================================================================

describe('GET /api/forecast — cursor-based traversal', () => {
  it('fetches all 24 points across multiple pages without gaps or overlaps', async () => {
    const allTimestamps: string[] = [];
    let cursor: string | undefined;

    // Page through with limit=7 — this gives pages of [7, 7, 7, 3]
    do {
      const url = cursor
        ? `/api/forecast?limit=7&cursor=${cursor}`
        : '/api/forecast?limit=7';
      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      const data: PaginatedForecastResponse = res.body.data;
      allTimestamps.push(...data.items.map((p) => p.timestamp));
      cursor = data.next_cursor;
    } while (cursor !== undefined);

    // Must have collected exactly 24 unique timestamps
    expect(allTimestamps).toHaveLength(24);
    expect(new Set(allTimestamps).size).toBe(24);
  });

  it('returns an empty items array when cursor points past the dataset end', async () => {
    // Encode a cursor pointing to index 100 (well past 24)
    const farCursor = Buffer.from('fc:100', 'utf-8').toString('base64url');
    const res = await request(app).get(`/api/forecast?cursor=${farCursor}`);

    expect(res.status).toBe(200);
    const data: PaginatedForecastResponse = res.body.data;
    expect(data.items).toHaveLength(0);
    expect(data.next_cursor).toBeUndefined();
    expect(data.total).toBe(24);
  });

  it('second page starts at item following the last item of the first page', async () => {
    // Page 1 — limit=3
    const res1 = await request(app).get('/api/forecast?limit=3');
    const page1Items: ForecastPoint[] = res1.body.data.items;
    const cursor = res1.body.data.next_cursor as string;

    // Page 2 — using cursor from page 1
    const res2 = await request(app).get(`/api/forecast?limit=3&cursor=${cursor}`);
    const page2Items: ForecastPoint[] = res2.body.data.items;

    // Pages should not overlap
    const p1ts = new Set(page1Items.map((p) => p.timestamp));
    for (const item of page2Items) {
      expect(p1ts.has(item.timestamp)).toBe(false);
    }
  });

  it('last page has no next_cursor', async () => {
    // Skip to the last 4 items (index 20 with limit=24)
    const cursor = Buffer.from('fc:20', 'utf-8').toString('base64url');
    const res = await request(app).get(`/api/forecast?limit=100&cursor=${cursor}`);

    expect(res.status).toBe(200);
    const data: PaginatedForecastResponse = res.body.data;
    expect(data.items).toHaveLength(4); // 24 - 20 = 4
    expect(data.next_cursor).toBeUndefined();
  });
});

// ===========================================================================
// GET /api/forecast — Pagination: invalid query parameters (400 errors)
// ===========================================================================

describe('GET /api/forecast — input validation (400)', () => {
  it('returns 400 when limit=0', async () => {
    const res = await request(app).get('/api/forecast?limit=0');
    expect(res.status).toBe(400);
  });

  it('returns 400 when limit=-1', async () => {
    const res = await request(app).get('/api/forecast?limit=-1');
    expect(res.status).toBe(400);
  });

  it('returns 400 when limit is a non-numeric string', async () => {
    const res = await request(app).get('/api/forecast?limit=abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 when limit is a decimal', async () => {
    const res = await request(app).get('/api/forecast?limit=3.5');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a tampered / malformed cursor', async () => {
    const res = await request(app).get('/api/forecast?cursor=notbase64!!!');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for a cursor with valid base64url but wrong payload format', async () => {
    // Encode something that decodes to a non-fc: prefix value
    const badCursor = Buffer.from('wrong:payload', 'utf-8').toString('base64url');
    const res = await request(app).get(`/api/forecast?cursor=${badCursor}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a cursor that decodes to a negative index', async () => {
    // "fc:-5" should be rejected
    const badCursor = Buffer.from('fc:-5', 'utf-8').toString('base64url');
    const res = await request(app).get(`/api/forecast?cursor=${badCursor}`);
    expect(res.status).toBe(400);
  });

  it('error response uses standard error envelope (success: false)', async () => {
    const res = await request(app).get('/api/forecast?limit=0');
    expect(res.body.success).toBe(false);
    // errorHandler puts error info under res.body.error OR at root level
    // Either way, success must be false
    expect(res.body.success).not.toBe(true);
  });
});

// ===========================================================================
// GET /api/forecast — No audit for read-only endpoint
// ===========================================================================

describe('GET /api/forecast — no audit logging', () => {
  it('does not record an audit event when listing forecasts', async () => {
    await request(app).get('/api/forecast');
    expect(mockAuditService.record).not.toHaveBeenCalled();
  });

  it('does not record an audit event even when cursor param is supplied', async () => {
    const cursor = Buffer.from('fc:0', 'utf-8').toString('base64url');
    await request(app).get(`/api/forecast?cursor=${cursor}`);
    expect(mockAuditService.record).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GET /api/forecast — Structured logging with correlation ID
// ===========================================================================

describe('GET /api/forecast — structured logging', () => {
  it('completes without error when X-Request-Id header is provided', async () => {
    const res = await request(app)
      .get('/api/forecast')
      .set('X-Request-Id', 'corr-abc-123');

    expect(res.status).toBe(200);
    // The correlation ID should be echoed back in the envelope
    expect(res.body.requestId).toBe('corr-abc-123');
  });
});

// ===========================================================================
// GET /api/forecast — Timeout behaviour
// ===========================================================================

describe('GET /api/forecast — timeout', () => {
  it('completes normally when well within timeout', async () => {
    const res = await request(app).get('/api/forecast');
    expect(res.status).toBe(200);
  });

  it('returns 504 GATEWAY_TIMEOUT when a slow route exceeds the timeout', async () => {
    const slowApp = express();
    slowApp.use(express.json());

    const router = express.Router();
    router.use(createTimeoutMiddleware({ durationMs: 50 }));
    // Deliberately hang without responding to trigger the timeout middleware
    router.get('/hang', (_req, _res) => {
      /* intentionally hangs */
    });

    slowApp.use('/api/forecast', router);
    slowApp.use(errorHandler);

    const res = await request(slowApp).get('/api/forecast/hang');
    expect(res.status).toBe(504);
    expect(res.body.code ?? res.body.error?.code).toBe('GATEWAY_TIMEOUT');
  });
});

// ===========================================================================
// Existing CRUD routes — ensure they still work after pagination changes
// ===========================================================================

describe('POST /api/forecast (create — audited)', () => {
  beforeEach(() => {
    mockJwt.verify = jest.fn().mockImplementation((token: string) => {
      const userId = (token as string).replace('mock-token-', '');
      return { userId, sub: userId };
    });
  });

  it('creates a forecast and returns 201', async () => {
    const token = createToken('dev-user-1');
    const res = await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My Forecast', description: 'Test description' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.name).toBe('My Forecast');
  });

  it('records audit event on create', async () => {
    const token = createToken('dev-user-1');
    await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Audit Test', description: 'Desc' });

    expect(mockAuditService.record).toHaveBeenCalledTimes(1);
    expect(mockAuditService.record.mock.calls[0][0].event).toBe('forecast.create');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/forecast')
      .send({ name: 'x', description: 'y' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const token = createToken('dev-user-1');
    const res = await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'No name' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/forecast/:id (read by ID)', () => {
  it('returns 404 for unknown ID', async () => {
    const res = await request(app).get('/api/forecast/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('returns the created forecast by ID', async () => {
    const token = createToken('dev-user-1');
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Named Forecast', description: 'For GET by ID test' });

    const id = createRes.body.data.id as string;
    const getRes = await request(app).get(`/api/forecast/${id}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(id);
    expect(getRes.body.data.name).toBe('Named Forecast');
  });
});

describe('PATCH /api/forecast/:id (update — audited)', () => {
  it('updates a forecast and records before/after in audit', async () => {
    const token = createToken('dev-user-2');
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Original', description: 'Orig Desc' });
    const id = createRes.body.data.id as string;
    jest.clearAllMocks();

    const patchRes = await request(app)
      .patch(`/api/forecast/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.name).toBe('Updated');

    const auditCall = mockAuditService.record.mock.calls[0][0];
    expect(auditCall.event).toBe('forecast.update');
    expect((auditCall.details!.before as Record<string, unknown>).name).toBe('Original');
    expect((auditCall.details!.after as Record<string, unknown>).name).toBe('Updated');
  });

  it('returns 400 for empty PATCH body', async () => {
    const token = createToken('dev-user-1');
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', description: 'y' });
    const id = createRes.body.data.id as string;

    const res = await request(app)
      .patch(`/api/forecast/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent ID', async () => {
    const token = createToken('dev-user-1');
    const res = await request(app)
      .patch('/api/forecast/does-not-exist')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/forecast/:id (delete — audited)', () => {
  it('deletes a forecast and returns 204', async () => {
    const token = createToken('dev-user-3');
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'To Delete', description: 'Will be gone' });
    const id = createRes.body.data.id as string;
    jest.clearAllMocks();

    const delRes = await request(app)
      .delete(`/api/forecast/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(delRes.status).toBe(204);
    expect(mockAuditService.record).toHaveBeenCalledTimes(1);
    expect(mockAuditService.record.mock.calls[0][0].event).toBe('forecast.delete');
    expect(mockAuditService.record.mock.calls[0][0].details!.after).toBeNull();
  });

  it('returns 404 when deleting non-existent forecast', async () => {
    const token = createToken('dev-user-1');
    const res = await request(app)
      .delete('/api/forecast/ghost-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).delete('/api/forecast/any-id');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// src/routes/__tests__/forecast.test.ts backward-compat parity
// (these mirror the simple assertions from the legacy test file to prevent
//  regression while the new envelope shape is adopted)
// ===========================================================================

describe('GET /api/forecast — backward-compat parity (legacy checks)', () => {
  it('returns 200 with data.items array (replaces legacy data.forecast)', async () => {
    const res = await request(app).get('/api/forecast');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('data.total is 24 (the full forecast horizon in hours)', async () => {
    const res = await request(app).get('/api/forecast');
    expect(res.body.data.total).toBe(24);
  });

  it('default page returns FORECAST_DEFAULT_LIMIT items', async () => {
    const res = await request(app).get('/api/forecast');
    expect(res.body.data.items).toHaveLength(FORECAST_DEFAULT_LIMIT);
  });
});
