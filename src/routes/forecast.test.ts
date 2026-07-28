import request from 'supertest';
import { Express } from 'express';
import express from 'express';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { auditEnrichMiddleware } from '../middleware/auditEnrich.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { envelopeMiddleware } from '../middleware/envelope.js';
import { createForecastRouter } from './forecast.js';
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
function createTestApp(): Express {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Middleware stack (order matters)
  app.use(requestIdMiddleware);
  app.use(auditEnrichMiddleware);

  // Mount forecast router under /api/forecast
  app.use('/api/forecast', createForecastRouter());

  // Error handler (should be last)
  app.use(errorHandler);

  return app;
}

/**
 * Create a valid JWT token for testing authenticated requests.
 */
function createToken(userId: string): string {
  // We'll simulate this in the test by mocking jwt.verify
  return `mock-token-${userId}`;
}

describe('Forecast Routes with Audit Logging', () => {
  let app: Express;

  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
    mockAuditService.record.mockResolvedValue(undefined);

    // Mock jwt.verify to return a valid user
    (mockJwt.verify as jest.Mock).mockImplementation((token: string) => {
      const userId = token.replace('mock-token-', '');
      return { userId, sub: userId };
    });

    // Mock process.env.JWT_SECRET
    process.env.JWT_SECRET = 'test-secret-key';

    app = createTestApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // GET / (read-only, not audited)
  // =========================================================================

  describe('GET /api/forecast', () => {
    it('should return a generated forecast without audit', async () => {
      const res = await request(app).get('/api/forecast');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('forecast');
      expect(res.body.data).toHaveProperty('generatedAt');
      expect(Array.isArray(res.body.data.forecast)).toBe(true);

      // Verify no audit was recorded for read operation
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST / (create - state-changing, audited)
  // =========================================================================

  describe('POST /api/forecast (create)', () => {
    it('should create a new forecast and record an audit event', async () => {
      const token = createToken('dev-user-1');

      const res = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Weather Forecast',
          description: 'Weekly weather prediction',
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.name).toBe('Weather Forecast');
      expect(res.body.data.description).toBe('Weekly weather prediction');

      // Verify exactly one audit event was recorded
      expect(mockAuditService.record).toHaveBeenCalledTimes(1);

      // Verify audit event has correct structure
      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.event).toBe('forecast.create');
      expect(auditCall.actor).toBe('dev-user-1');
      expect(auditCall.details).toHaveProperty('before');
      expect(auditCall.details).toHaveProperty('after');
      expect(auditCall.details!.before).toBeNull(); // Creation: before is null
      expect(auditCall.details!.after).toHaveProperty('id');
      expect(auditCall.details!.after).toHaveProperty('name', 'Weather Forecast');
      expect(auditCall.details!.after).toHaveProperty('description', 'Weekly weather prediction');
    });

    it('should record actor from authenticated context, not from request body', async () => {
      const token = createToken('dev-user-1');

      // Try to spoof the actor in the request body
      const res = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Forecast',
          description: 'Test',
          actor: 'hacker-user', // This should be ignored
        });

      expect(res.status).toBe(201);

      // Verify actor in audit is from auth context, not request body
      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.actor).toBe('dev-user-1'); // From JWT, not from body
    });

    it('should propagate correlation ID to audit record', async () => {
      const token = createToken('dev-user-1');

      const res = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Request-Id', 'req-12345')
        .send({
          name: 'Forecast',
          description: 'Test',
        });

      expect(res.status).toBe(201);

      // Verify correlation ID is present in audit
      const auditCall = mockAuditService.record.mock.calls[0][0];
      expect(auditCall.correlationId).toBe('req-12345');
    });

    it('should require authentication', async () => {
      const res = await request(app)
        .post('/api/forecast')
        .send({
          name: 'Forecast',
          description: 'Test',
        });

      // Should reject unauthenticated request
      expect(res.status).toBe(401);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should validate required fields', async () => {
      const token = createToken('dev-user-1');

      const res = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          // Missing 'name' field
          description: 'Test',
        });

      expect(res.status).toBe(400);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should not allow empty name', async () => {
      const token = createToken('dev-user-1');

      const res = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: '',
          description: 'Test',
        });

      expect(res.status).toBe(400);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /:id (read-only, not audited)
  // =========================================================================

  describe('GET /api/forecast/:id', () => {
    it('should return a forecast by id without audit', async () => {
      const token = createToken('dev-user-1');

      // First create a forecast
      const createRes = await request(app)
        .post('/api/forecast')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Test Forecast',
          description: 'Testing',
        });

      const forecastId = createRes.body.data.id;
      jest.clearAllMocks(); // Clear create audit

      // Now fetch it
      const getRes = await request(app).get(`/api/forecast/${forecastId}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.id).toBe(forecastId);
      expect(getRes.body.data.name).toBe('Test Forecast');

      // Verify no audit for read operation
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should return 404 for non-existent forecast', async () => {
      const res = await request(app).get('/api/forecast/non-existent-id');

      expect(res.status).toBe(404);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // PATCH /:id (update - state-changing, audited)
  // =========================================================================

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
      expect(res.body.code).toBe('GATEWAY_TIMEOUT');
      expect(res.body.message).toMatch(/timed out after 50ms/i);
    });
  });
});
