/**
 * Security Headers Tests for /api/webhooks
 *
 * Verifies that webhook responses include the required security headers:
 * - Content-Security-Policy
 * - X-Content-Type-Options
 * - Referrer-Policy
 */

import request from 'supertest';
import express from 'express';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { errorHandler } from '../middleware/errorHandler.js';
import webhookRoutes from '../webhooks/webhook.routes.js';
import webhooksRouter from '../routes/webhooks.js';
import { createSecurityHeadersMiddleware } from '../middleware/securityHeaders.js';
import { WebhookStore } from '../webhooks/webhook.store.js';

// Mock better-sqlite3 to prevent native binding errors
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() {}
    close() {}
  };
});

describe('Security Headers on /api/webhooks', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.use('/api/webhooks', webhookRoutes);
    app.use(errorHandler);

    WebhookStore.clear();
    WebhookStore.clearDlq();
    WebhookStore.clearFailedDeliveries();
  });

  describe('POST /api/webhooks', () => {
    it('returns Content-Security-Policy header', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .send({
          developerId: 'dev-test',
          url: 'https://example.com/webhook',
          events: ['new_api_call'],
        });

      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    });

    it('returns X-Content-Type-Options header', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .send({
          developerId: 'dev-test',
          url: 'https://example.com/webhook',
          events: ['new_api_call'],
        });

      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns Referrer-Policy header', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .send({
          developerId: 'dev-test',
          url: 'https://example.com/webhook',
          events: ['new_api_call'],
        });

      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('GET /api/webhooks/:developerId', () => {
    it('returns security headers on error response', async () => {
      const res = await request(app)
        .get('/api/webhooks/nonexistent-dev');

      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('DELETE /api/webhooks/:developerId', () => {
    it('returns security headers on response', async () => {
      const res = await request(app)
        .delete('/api/webhooks/nonexistent-dev');

      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('src/routes/webhooks.ts export router', () => {
    it('applies security headers when mounted via src/routes/webhooks.js', async () => {
      const routeApp = express();
      routeApp.use(requestIdMiddleware);
      routeApp.use(express.json());
      routeApp.use('/api/webhooks', webhooksRouter);
      routeApp.use(errorHandler);

      const res = await request(routeApp).get('/api/webhooks/nonexistent-dev');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('createSecurityHeadersMiddleware unit tests', () => {
    it('allows custom security header options', async () => {
      const customApp = express();
      customApp.use(
        createSecurityHeadersMiddleware({
          contentSecurityPolicy: "default-src 'none'",
          contentTypeOptions: 'nosniff',
          referrerPolicy: 'no-referrer',
        })
      );
      customApp.get('/test', (_req, res) => {
        res.send('ok');
      });

      const res = await request(customApp).get('/test');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
  });
});
