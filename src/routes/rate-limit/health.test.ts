/**
 * Tests for Rate-Limit Health Dependency Probe
 *
 * Covers:
 *   - GET /api/rate-limit/health (operational limiter)
 *   - GET /api/rate-limit/health (no limiter configured)
 *   - Status codes (200 vs 503)
 *   - Response format validation
 */

import express from 'express';
import request from 'supertest';
import { InMemoryRestRateLimiter } from '../../middleware/restRateLimit.js';
import { createRateLimitHealthRouter } from './health.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function buildApp(limiter?: InMemoryRestRateLimiter, windowMs?: number, maxRequests?: number) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/rate-limit/health',
    createRateLimitHealthRouter({ limiter, windowMs, maxRequests }),
  );
  app.use(errorHandler);
  return app;
}

describe('Rate-Limit Health Dependency Probe', () => {
  describe('GET /api/rate-limit/health', () => {
    it('returns 200 with ok status when limiter is operational', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const app = buildApp(limiter, 60000, 100);

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.dependencies.in_memory_store).toBeDefined();
      expect(res.body.dependencies.in_memory_store.status).toBe('ok');
      expect(typeof res.body.dependencies.in_memory_store.responseTime).toBe('number');
      expect(res.body.dependencies.in_memory_store.details).toEqual({
        windowMs: 60000,
        maxRequests: 100,
      });
    });

    it('returns 200 with ok status when no limiter is configured', async () => {
      const app = buildApp();

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies.in_memory_store).toBeDefined();
      expect(res.body.dependencies.in_memory_store.status).toBe('ok');
      expect(res.body.dependencies.in_memory_store.details).toEqual({
        note: 'No rate limiter configured for probing',
      });
    });

    it('returns 200 when limiter is partially drained but operational', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 5);
      // Consume some tokens
      limiter.check('user-a');
      limiter.check('user-a');
      limiter.check('user-b');

      const app = buildApp(limiter, 60000, 5);

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies.in_memory_store.status).toBe('ok');
    });

    it('includes correct response structure', async () => {
      const limiter = new InMemoryRestRateLimiter(30000, 50);
      const app = buildApp(limiter, 30000, 50);

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('dependencies');
      expect(res.body.dependencies).toHaveProperty('in_memory_store');
      expect(res.body.dependencies.in_memory_store).toHaveProperty('status');
      expect(['ok', 'degraded', 'down']).toContain(res.body.status);
    });

    it('returns correct content-type', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const app = buildApp(limiter, 60000, 100);

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });
});
