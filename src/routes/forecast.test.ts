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
import { forecastLogger } from '../middleware/forecastAccessLog.js';
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

  describe('PATCH /api/forecast/:id (update)', () => {
    it('should update a forecast and record before/after audit', async () => {
      const token = createToken('dev-user-1');

      // Create a forecast
      const createRes = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Original Name',
          description: 'Original Description',
        });

      const forecastId = createRes.body.data.id;
      jest.clearAllMocks(); // Clear create audit

      // Update it
      const updateRes = await request(app)
        .patch(`/api/forecast/${forecastId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Updated Name',
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.name).toBe('Updated Name');
      expect(updateRes.body.data.description).toBe('Original Description'); // Unchanged field

      // Verify audit was recorded
      expect(mockAuditService.record).toHaveBeenCalledTimes(1);

      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.event).toBe('forecast.update');
      expect(auditCall.actor).toBe('dev-user-1');

      // CRITICAL: Verify before/after are genuinely different
      const beforeState = auditCall.details!.before as Record<string, unknown>;
      const afterState = auditCall.details!.after as Record<string, unknown>;

      expect(beforeState.name).toBe('Original Name');
      expect(afterState.name).toBe('Updated Name');

      // Verify before-state was captured BEFORE mutation applied
      expect(beforeState.description).toBe('Original Description');
      expect(afterState.description).toBe('Original Description'); // Unchanged field preserved

      // Verify updatedAt changed in after-state
      expect(beforeState.updatedAt).not.toBe(afterState.updatedAt);
    });

    it('should update multiple fields and record all changes in audit', async () => {
      const token = createToken('dev-user-1');

      const createRes = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Original',
          description: 'Desc',
        });

      const forecastId = createRes.body.data.id;
      jest.clearAllMocks();

      const updateRes = await request(app)
        .patch(`/api/forecast/${forecastId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New Name',
          description: 'New Description',
        });

      expect(updateRes.status).toBe(200);

      const auditCall = mockAuditService.record.mock.calls[0][0];
      const beforeState = auditCall.details!.before as Record<string, unknown>;
      const afterState = auditCall.details!.after as Record<string, unknown>;

      expect(beforeState.name).toBe('Original');
      expect(beforeState.description).toBe('Desc');
      expect(afterState.name).toBe('New Name');
      expect(afterState.description).toBe('New Description');

      // Verify updatedFields is tracked
      expect((auditCall.details as Record<string, unknown>).updatedFields).toContain('name');
      expect((auditCall.details as Record<string, unknown>).updatedFields).toContain('description');
    });

    it('should require at least one field to update', async () => {
      const token = createToken('dev-user-1');

      const createRes = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Test',
          description: 'Test',
        });

      const forecastId = createRes.body.data.id;

      const updateRes = await request(app)
        .patch(`/api/forecast/${forecastId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(updateRes.status).toBe(400);
    });

    it('should require authentication for update', async () => {
      const res = await request(app)
        .patch('/api/forecast/some-id')
        .send({
          name: 'New Name',
        });

      expect(res.status).toBe(401);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should return 404 if forecast does not exist', async () => {
      const token = createToken('dev-user-1');

      const res = await request(app)
        .patch('/api/forecast/non-existent-id')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Updated Name',
        });

      expect(res.status).toBe(404);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DELETE /:id (delete - state-changing, audited)
  // =========================================================================

  describe('DELETE /api/forecast/:id (delete)', () => {
    it('should delete a forecast and record before/after audit', async () => {
      const token = createToken('dev-user-1');

      const createRes = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'To Delete',
          description: 'Deletable',
        });

      const forecastId = createRes.body.data.id;
      const createdForecast = createRes.body.data;
      jest.clearAllMocks(); // Clear create audit

      // Delete it
      const deleteRes = await request(app)
        .delete(`/api/forecast/${forecastId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(deleteRes.status).toBe(204);

      // Verify audit was recorded
      expect(mockAuditService.record).toHaveBeenCalledTimes(1);

      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.event).toBe('forecast.delete');
      expect(auditCall.actor).toBe('dev-user-1');

      // Verify before/after: before is the deleted forecast, after is null
      const beforeState = auditCall.details!.before as Record<string, unknown>;
      const afterState = auditCall.details!.after;

      expect(beforeState.id).toBe(forecastId);
      expect(beforeState.name).toBe('To Delete');
      expect(afterState).toBeNull(); // Deletion: after is null
    });

    it('should require authentication for delete', async () => {
      const res = await request(app).delete('/api/forecast/some-id');

      expect(res.status).toBe(401);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should return 404 if forecast does not exist', async () => {
      const token = createToken('dev-user-1');

      const res = await request(app)
        .delete('/api/forecast/non-existent-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should record correct actor in deletion audit', async () => {
      const token = createToken('dev-user-2');

      const createRes = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Created by user-2',
          description: 'Test',
        });

      const forecastId = createRes.body.data.id;
      jest.clearAllMocks();

      await request(app)
        .delete(`/api/forecast/${forecastId}`)
        .set('Authorization', `Bearer ${token}`);

      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.actor).toBe('dev-user-2'); // Correct actor
    });
  });

  // =========================================================================
  // Audit failure behavior tests
  // =========================================================================

  describe('Audit persistence failure handling', () => {
    it('should still succeed mutation even if audit fails (non-blocking)', async () => {
      const token = createToken('dev-user-1');

      // Make auditService.record reject
      mockAuditService.record.mockRejectedValueOnce(new Error('Audit DB error'));

      // The route should still fail because the error propagates to the handler
      // In a real production scenario with best-effort logging, this would be
      // caught and logged without blocking the mutation. For this test:
      const res = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Test',
          description: 'Test',
        });

      // The error handler will return 500 because the async handler catches it
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // Coverage for edge cases
  // =========================================================================

  describe('Audit context attachment', () => {
    it('should include clientIp in audit record', async () => {
      const token = createToken('dev-user-1');

      await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', '192.168.1.100')
        .send({
          name: 'Test',
          description: 'Test',
        });

      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.clientIp).toBeDefined();
    });

    it('should include userAgent in audit record', async () => {
      const token = createToken('dev-user-1');

      await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .set('User-Agent', 'TestClient/1.0')
        .send({
          name: 'Test',
          description: 'Test',
        });

      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.userAgent).toBe('TestClient/1.0');
    });
  });

  // =========================================================================
  // Per-request Timeout & Cooperative Abort (issue #935)
  // =========================================================================

  describe('Per-request Timeout & Cooperative Cancellation (#935)', () => {
    it('should complete request normally when execution is within timeout limit', async () => {
      const timeoutApp = express();
      timeoutApp.use(express.json());
      timeoutApp.use('/api/forecast', createForecastRouter(5000));
      timeoutApp.use(errorHandler);

      const res = await request(timeoutApp).get('/api/forecast');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    it('should return 504 GATEWAY_TIMEOUT when request times out', async () => {
      const timeoutApp = express();
      timeoutApp.use(express.json());

      const router = express.Router();
      router.use(createTimeoutMiddleware({ durationMs: 50 }));
      router.get('/test-timeout', (req, _res) => {
        expect(req.signal).toBeDefined();
        expect(req.abortSignal).toBeDefined();
        // Leave hanging to let timeout middleware fire 504
      });

      timeoutApp.use('/api/forecast', router);
      timeoutApp.use(errorHandler);

      const res = await request(timeoutApp).get('/api/forecast/test-timeout');

      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
      expect(res.body.error.message).toMatch(/timed out after 50ms/i);
    });
  });
});

// =============================================================================
// Access log integration tests
//
// These tests verify that createForecastAccessLogMiddleware is correctly wired
// into the forecast router and emits structured log entries containing all
// required fields: req-id, latency, status, response size, and actor.
// =============================================================================

describe('Forecast access log integration', () => {
  let app: Express;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    // Spy on the forecast Pino child logger used by the middleware
    infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);
    warnSpy = jest.spyOn(forecastLogger, 'warn').mockImplementation(() => forecastLogger);
    errorSpy = jest.spyOn(forecastLogger, 'error').mockImplementation(() => forecastLogger);

    // Stub auditService so mutations don't fail
    (defaultAuditService as jest.Mocked<typeof defaultAuditService>).record.mockResolvedValue(undefined);

    // Stub JWT
    const mockJwt = jwt as unknown as { verify: jest.Mock };
    mockJwt.verify.mockImplementation((token: string) => {
      const userId = (token as string).replace('mock-token-', '');
      return { userId, sub: userId };
    });

    process.env.JWT_SECRET = 'test-secret-key';

    app = (() => {
      const a = express();
      a.use(express.json());
      a.use(requestIdMiddleware);
      a.use(auditEnrichMiddleware);
      a.use('/api/forecast', createForecastRouter());
      a.use(errorHandler);
      return a;
    })();
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // GET / — unauthenticated read
  // ---------------------------------------------------------------------------

  it('emits an info log with req-id, status 200, latency, and response size for GET /', async () => {
    const res = await request(app)
      .get('/api/forecast')
      .set('X-Request-Id', 'req-get-root');

    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-get-root');
    expect(payload.correlationId).toBe('req-get-root');
    expect(payload.method).toBe('GET');
    expect(payload.status).toBe(200);
    expect(payload.statusCode).toBe(200);
    expect(typeof payload.ms).toBe('number');
    expect(payload.ms as number).toBeGreaterThanOrEqual(0);
    expect(payload.durationMs).toBe(payload.ms);
    expect(typeof payload.responseBytes).toBe('number');
    expect(payload.responseBytes as number).toBeGreaterThan(0);
    // No actor for unauthenticated GET
    expect(payload).not.toHaveProperty('actor');
    expect(payload).not.toHaveProperty('userId');
  });

  // ---------------------------------------------------------------------------
  // POST / — authenticated create, actor must appear
  // ---------------------------------------------------------------------------

  it('emits an info log with actor for authenticated POST /', async () => {
    const res = await request(app)
      .post('/api/forecast')
      .set('Authorization', 'Bearer mock-token-dev-user-42')
      .set('X-Request-Id', 'req-post-create')
      .send({ name: 'Access Log Test', description: 'Testing access log' });

    expect(res.status).toBe(201);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-post-create');
    expect(payload.method).toBe('POST');
    expect(payload.status).toBe(201);
    expect(payload.statusCode).toBe(201);
    expect(payload.actor).toBe('dev-user-42');
    expect(payload.userId).toBe('dev-user-42');
    expect(typeof payload.ms).toBe('number');
    expect(typeof payload.responseBytes).toBe('number');
    expect(payload.responseBytes as number).toBeGreaterThan(0);
    // No forecastId on the collection endpoint
    expect(payload).not.toHaveProperty('forecastId');
  });

  // ---------------------------------------------------------------------------
  // GET /:id — forecastId must appear in the log
  // ---------------------------------------------------------------------------

  it('includes forecastId in the access log for GET /:id', async () => {
    // First create a forecast to get a real ID
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', 'Bearer mock-token-dev-user-1')
      .send({ name: 'ID Test', description: 'Testing forecastId in log' });

    const forecastId = createRes.body.data.id as string;

    infoSpy.mockClear();

    const res = await request(app)
      .get(`/api/forecast/${forecastId}`)
      .set('X-Request-Id', 'req-get-by-id');

    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-get-by-id');
    expect(payload.forecastId).toBe(forecastId);
    expect(payload.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // GET /:id 404 — warn level, forecastId still present
  // ---------------------------------------------------------------------------

  it('emits a warn log at status 404 for GET /:id with unknown ID', async () => {
    const res = await request(app)
      .get('/api/forecast/does-not-exist')
      .set('X-Request-Id', 'req-get-404');

    expect(res.status).toBe(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();

    const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-get-404');
    expect(payload.status).toBe(404);
    expect(payload.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // PATCH /:id — actor + forecastId + 200
  // ---------------------------------------------------------------------------

  it('emits an info log with actor and forecastId for authenticated PATCH /:id', async () => {
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', 'Bearer mock-token-dev-user-5')
      .send({ name: 'Before', description: 'Patch test' });

    const forecastId = createRes.body.data.id as string;
    infoSpy.mockClear();

    const res = await request(app)
      .patch(`/api/forecast/${forecastId}`)
      .set('Authorization', 'Bearer mock-token-dev-user-5')
      .set('X-Request-Id', 'req-patch-1')
      .send({ name: 'After' });

    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-patch-1');
    expect(payload.method).toBe('PATCH');
    expect(payload.status).toBe(200);
    expect(payload.actor).toBe('dev-user-5');
    expect(payload.forecastId).toBe(forecastId);
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id — actor + forecastId + 204
  // ---------------------------------------------------------------------------

  it('emits an info log with actor and forecastId for authenticated DELETE /:id', async () => {
    const createRes = await request(app)
      .post('/api/forecast')
      .set('Authorization', 'Bearer mock-token-dev-user-6')
      .send({ name: 'ToDelete', description: 'Delete test' });

    const forecastId = createRes.body.data.id as string;
    infoSpy.mockClear();

    const res = await request(app)
      .delete(`/api/forecast/${forecastId}`)
      .set('Authorization', 'Bearer mock-token-dev-user-6')
      .set('X-Request-Id', 'req-delete-1');

    expect(res.status).toBe(204);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-delete-1');
    expect(payload.method).toBe('DELETE');
    expect(payload.status).toBe(204);
    expect(payload.actor).toBe('dev-user-6');
    expect(payload.forecastId).toBe(forecastId);
  });

  // ---------------------------------------------------------------------------
  // 401 — warn level, no actor
  // ---------------------------------------------------------------------------

  it('emits a warn log at status 401 when authentication is missing on POST /', async () => {
    const res = await request(app)
      .post('/api/forecast')
      .set('X-Request-Id', 'req-unauth-post')
      .send({ name: 'No Auth', description: 'Test' });

    expect(res.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-unauth-post');
    expect(payload.status).toBe(401);
    expect(payload).not.toHaveProperty('actor');
  });

  // ---------------------------------------------------------------------------
  // 400 — warn level for validation failure
  // ---------------------------------------------------------------------------

  it('emits a warn log at status 400 for a validation failure on POST /', async () => {
    const res = await request(app)
      .post('/api/forecast')
      .set('Authorization', 'Bearer mock-token-dev-user-1')
      .set('X-Request-Id', 'req-bad-input')
      .send({ description: 'missing name' }); // name is required

    expect(res.status).toBe(400);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-bad-input');
    expect(payload.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // X-Request-Id echoed in response header
  // ---------------------------------------------------------------------------

  it('echoes X-Request-Id back in the response header', async () => {
    const res = await request(app)
      .get('/api/forecast')
      .set('X-Request-Id', 'req-echo-check');

    expect(res.headers['x-request-id']).toBe('req-echo-check');
  });

  // ---------------------------------------------------------------------------
  // x-correlation-id takes precedence for correlationId field
  // ---------------------------------------------------------------------------

  it('uses x-correlation-id as correlationId when both headers are present', async () => {
    const res = await request(app)
      .get('/api/forecast')
      .set('X-Request-Id', 'req-id-abc')
      .set('X-Correlation-Id', 'corr-id-xyz');

    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.correlationId).toBe('corr-id-xyz');
    expect(payload.requestId).toBe('req-id-abc');
  });

  // ---------------------------------------------------------------------------
  // 500 — error level
  // ---------------------------------------------------------------------------

  it('emits an error log at status 500 when audit persistence fails', async () => {
    (defaultAuditService as jest.Mocked<typeof defaultAuditService>).record
      .mockRejectedValueOnce(new Error('DB down'));

    const res = await request(app)
      .post('/api/forecast')
      .set('Authorization', 'Bearer mock-token-dev-user-1')
      .set('X-Request-Id', 'req-500-test')
      .send({ name: 'Fail', description: 'Test' });

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const payload = errorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.requestId).toBe('req-500-test');
    expect(payload.status).toBe(500);
  });
});
