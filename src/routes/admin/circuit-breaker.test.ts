/**
 * Tests for Admin Circuit Breaker Endpoint.
 *
 * Covers:
 *   - GET    /api/admin/circuit-breakers               (list all)
 *   - GET    /api/admin/circuit-breakers/:breakerKey   (get details)
 *   - POST   /api/admin/circuit-breakers/:breakerKey/reset  (force-close)
 *   - POST   /api/admin/circuit-breakers/:breakerKey/trip   (force-open)
 *   - Error handling, validation, and HTTP status codes.
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAdminCircuitBreakerRouter } from './circuit-breaker.js';
import {
  BreakerRegistry,
  CircuitBreakerState,
} from '../../lib/circuitBreaker.js';
import { AppError } from '../../errors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-admin-key';

function buildApp(registry?: BreakerRegistry) {
  const app = express();
  app.use(express.json());

  // Simulate admin authentication
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });

  app.use('/api/admin/circuit-breakers', createAdminCircuitBreakerRouter({ registry }));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Admin Circuit Breaker Endpoint', () => {
  let registry: BreakerRegistry;

  beforeEach(() => {
    registry = new BreakerRegistry();
    jest.clearAllMocks();
  });

  // ── GET /api/admin/circuit-breakers ──────────────────────────────────

  describe('GET /api/admin/circuit-breakers', () => {
    it('returns 200 with empty array when no breakers registered', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns 200 with all registered breakers', async () => {
      const breaker1 = registry.getOrCreate('api-weather', { failureThreshold: 2 });
      registry.getOrCreate('api-payments');

      // Trip one to give it a non-default state
      const failOp = jest.fn().mockRejectedValue(new Error('fail'));
      await breaker1.execute('api-weather', failOp).catch(() => {});
      await breaker1.execute('api-weather', failOp).catch(() => {});

      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);

      const slugs = res.body.data.map((e: { slug: string }) => e.slug).sort();
      expect(slugs).toEqual(['api-payments', 'api-weather']);

      const weatherEntry = res.body.data.find((e: { slug: string }) => e.slug === 'api-weather');
      expect(weatherEntry.state).toBe('open');
      expect(weatherEntry.metrics).toBeDefined();
      expect(weatherEntry.metrics.totalFailures).toBe(2);
    });

    it('returns 401 when unauthorized', async () => {
      const app = buildApp(registry);
      const res = await request(app).get('/api/admin/circuit-breakers');
      expect(res.status).toBe(401);
    });

    it('returns 500 when registry.list() throws a non-AppError', async () => {
      const mockRegistry = {
        list: jest.fn().mockRejectedValue(new Error('unexpected')),
      } as unknown as BreakerRegistry;
      const app = buildApp(mockRegistry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('returns the original status when registry.list() throws an AppError', async () => {
      const mockRegistry = {
        list: jest.fn().mockRejectedValue(new AppError('quota exceeded', 429, 'RATE_LIMITED')),
      } as unknown as BreakerRegistry;
      const app = buildApp(mockRegistry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(429);
    });
  });

  // ── GET /api/admin/circuit-breakers/:breakerKey ──────────────────────

  describe('GET /api/admin/circuit-breakers/:breakerKey', () => {
    it('returns 200 with breaker details', async () => {
      const breaker = registry.getOrCreate('my-api');
      const successOp = jest.fn().mockResolvedValue('ok');
      await breaker.execute('my-api', successOp);
      await breaker.execute('my-api', successOp);

      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers/my-api')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.slug).toBe('my-api');
      expect(res.body.data.state).toBe('closed');
      expect(res.body.data.metrics.totalSuccesses).toBe(2);
    });

    it('returns 404 for non-existent breaker key', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers/non-existent')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for invalid breaker key format', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers/invalid%20key%20with%20spaces%21')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(400);
    });

    it('returns 401 when unauthorized', async () => {
      const app = buildApp(registry);
      const res = await request(app).get('/api/admin/circuit-breakers/my-api');
      expect(res.status).toBe(401);
    });

    it('returns 500 when getMetrics throws a non-AppError', async () => {
      const breaker = registry.getOrCreate('boom-api');
      jest.spyOn(breaker, 'getMetrics').mockRejectedValue(new Error('db connection lost'));
      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers/boom-api')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('returns the original status when getMetrics throws an AppError', async () => {
      const breaker = registry.getOrCreate('apperror-api');
      jest.spyOn(breaker, 'getMetrics').mockRejectedValue(new AppError('rate limit', 429, 'RATE_LIMITED'));
      const app = buildApp(registry);
      const res = await request(app)
        .get('/api/admin/circuit-breakers/apperror-api')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(429);
    });
  });

  // ── POST /api/admin/circuit-breakers/:breakerKey/reset ───────────────

  describe('POST /api/admin/circuit-breakers/:breakerKey/reset', () => {
    it('returns 200 and resets an open breaker to closed', async () => {
      const breaker = registry.getOrCreate('broken-api', { failureThreshold: 2 });
      const failOp = jest.fn().mockRejectedValue(new Error('fail'));

      // Trip the breaker
      await breaker.execute('broken-api', failOp).catch(() => {});
      await breaker.execute('broken-api', failOp).catch(() => {});
      expect(await breaker.getState('broken-api')).toBe(CircuitBreakerState.OPEN);

      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/broken-api/reset')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.priorState).toBe('open');
      expect(res.body.data.currentState).toBe('closed');
      expect(await breaker.getState('broken-api')).toBe(CircuitBreakerState.CLOSED);
    });

    it('returns 200 when resetting an already-closed breaker', async () => {
      registry.getOrCreate('healthy-api');

      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/healthy-api/reset')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.priorState).toBe('closed');
      expect(res.body.data.currentState).toBe('closed');
    });

    it('returns 404 for non-existent breaker key', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/non-existent/reset')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for invalid breaker key format', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/UPPER%20CASE/reset')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(400);
    });

    it('returns 401 when unauthorized', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/my-api/reset');
      expect(res.status).toBe(401);
    });

    it('returns 500 when reset throws a non-AppError', async () => {
      const breaker = registry.getOrCreate('fail-reset-api');
      jest.spyOn(breaker, 'reset').mockRejectedValue(new Error('disk full'));
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/fail-reset-api/reset')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('returns the original status when reset throws an AppError', async () => {
      const breaker = registry.getOrCreate('apperror-reset');
      jest.spyOn(breaker, 'reset').mockRejectedValue(new AppError('forbidden', 403, 'FORBIDDEN'));
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/apperror-reset/reset')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/admin/circuit-breakers/:breakerKey/trip ────────────────

  describe('POST /api/admin/circuit-breakers/:breakerKey/trip', () => {
    it('returns 200 and trips a closed breaker to open', async () => {
      registry.getOrCreate('target-api');

      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/target-api/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ reason: 'Emergency maintenance' });

      expect(res.status).toBe(200);
      expect(res.body.data.priorState).toBe('closed');
      expect(res.body.data.currentState).toBe('open');
      expect(res.body.data.reason).toBe('Emergency maintenance');

      const breaker = registry.get('target-api')!;
      expect(await breaker.getState('target-api')).toBe(CircuitBreakerState.OPEN);
    });

    it('returns 200 with idempotent response when breaker is already open', async () => {
      const breaker = registry.getOrCreate('already-open');
      await breaker.trip('already-open');

      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/already-open/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ reason: 'Double trip' });

      expect(res.status).toBe(200);
      expect(res.body.data.priorState).toBe('open');
      expect(res.body.data.currentState).toBe('open');
      expect(res.body.data.message).toBe('Circuit breaker is already open');
    });

    it('creates and trips a non-existent breaker key', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/new-api/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ reason: 'Proactive trip' });

      expect(res.status).toBe(200);
      expect(res.body.data.priorState).toBe('closed');
      expect(res.body.data.currentState).toBe('open');
    });

    it('uses default reason when none provided', async () => {
      registry.getOrCreate('no-reason-api');

      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/no-reason-api/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.reason).toBe('Manual trip via admin API');
    });

    it('returns 400 for invalid breaker key format', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/invalid%20key%21/trip')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(400);
    });

    it('returns 401 when unauthorized', async () => {
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/my-api/trip');
      expect(res.status).toBe(401);
    });

    it('rejects reason exceeding max length', async () => {
      registry.getOrCreate('long-reason-api');

      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/long-reason-api/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ reason: 'x'.repeat(513) });

      expect(res.status).toBe(400);
    });

    it('returns 500 when trip throws a non-AppError', async () => {
      const breaker = registry.getOrCreate('fail-trip-api');
      jest.spyOn(breaker, 'trip').mockRejectedValue(new Error('network timeout'));
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/fail-trip-api/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ reason: 'trigger error' });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('returns the original status when trip throws an AppError', async () => {
      const breaker = registry.getOrCreate('apperror-trip');
      jest.spyOn(breaker, 'trip').mockRejectedValue(new AppError('service unavailable', 503, 'SERVICE_UNAVAILABLE'));
      const app = buildApp(registry);
      const res = await request(app)
        .post('/api/admin/circuit-breakers/apperror-trip/trip')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ reason: 'test' });

      expect(res.status).toBe(503);
    });
  });
});
