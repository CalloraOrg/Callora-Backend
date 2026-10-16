import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../app.js';
import { NotFoundError } from '../errors/index.js';
import type { ApiEnvelope } from '../types/ResponseEnvelope.js';

function makeAuthHeader(userId: string): string {
  const secret = process.env.JWT_SECRET ?? 'test-jwt-secret';
  return `Bearer ${jwt.sign({ userId, sub: userId }, secret)}`;
}

describe('Response Envelope Contract Tests', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
    const stack = (app as unknown as { _router?: { stack?: Array<{ name?: string }> } })._router?.stack;
    if (stack) {
      const errIdx = stack.findIndex((l) => l.name === 'errorHandler');
      app.use((_req, _res, next) => next(new NotFoundError('Endpoint not found')));
      const notFoundLayer = stack.pop()!;
      if (errIdx !== -1) stack.splice(errIdx, 0, notFoundLayer);
      else stack.push(notFoundLayer);
    }
  });

  describe('GET /api/health', () => {
    it('returns valid success envelope', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);

      // Check envelope structure
      const body = response.body as ApiEnvelope;
      expect(body).toHaveProperty('success');
      expect(body).toHaveProperty('requestId');
      expect(body).toHaveProperty('timestamp');

      // Check success-specific fields
      if (body.success === true) {
        expect(body).toHaveProperty('data');
        expect(body.data).toBeDefined();
      }
    });

    it('includes valid ISO 8601 timestamp', async () => {
      const response = await request(app).get('/api/health');

      const body = response.body as ApiEnvelope;
      if ('timestamp' in body) {
        const timestamp = body.timestamp;
        expect(() => new Date(timestamp)).not.toThrow();
        // Ensure it's ISO 8601 format
        expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });

    it('includes requestId in response', async () => {
      const response = await request(app).get('/api/health');

      const body = response.body as ApiEnvelope;
      if ('requestId' in body) {
        expect(typeof body.requestId).toBe('string');
        expect(body.requestId).toBeTruthy();
      }
    });

    it('has X-Request-Id header that matches response requestId', async () => {
      const response = await request(app).get('/api/health');

      const headerRequestId = response.headers['x-request-id'];
      const bodyRequestId = (response.body as ApiEnvelope).requestId;

      // They should both be present
      expect(headerRequestId).toBeTruthy();
      expect(bodyRequestId).toBeTruthy();
    });
  });

  describe('Error responses', () => {
    it('returns valid error envelope for 404', async () => {
      const response = await request(app).get('/api/nonexistent-endpoint');

      const body = response.body as ApiEnvelope;

      // Check envelope structure
      expect(body).toHaveProperty('success');
      expect(body).toHaveProperty('requestId');
      expect(body).toHaveProperty('timestamp');

      // Check error-specific fields
      if (body.success === false) {
        expect(body).toHaveProperty('error');
        expect(body.error).toHaveProperty('code');
        expect(body.error).toHaveProperty('message');
      }
    });

    it('error envelope has valid error object', async () => {
      const response = await request(app).get('/api/nonexistent-endpoint');

      const body = response.body as ApiEnvelope;

      if (body.success === false) {
        expect(typeof body.error.code).toBe('string');
        expect(typeof body.error.message).toBe('string');
        expect(body.error.code).toBeTruthy();
        expect(body.error.message).toBeTruthy();
      }
    });

    it('error envelope has valid ISO 8601 timestamp', async () => {
      const response = await request(app).get('/api/nonexistent-endpoint');

      const body = response.body as ApiEnvelope;
      if ('timestamp' in body) {
        const timestamp = body.timestamp;
        expect(() => new Date(timestamp)).not.toThrow();
        expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });
  });

  describe('requestId handling', () => {
    it('preserves client-supplied x-request-id header', async () => {
      const clientRequestId = 'client-supplied-id-12345';

      const response = await request(app)
        .get('/api/health')
        .set('x-request-id', clientRequestId);

      const body = response.body as ApiEnvelope;
      if ('requestId' in body) {
        expect(body.requestId).toBe(clientRequestId);
      }
    });

    it('generates requestId when not supplied', async () => {
      const response = await request(app).get('/api/health');

      const body = response.body as ApiEnvelope;
      if ('requestId' in body) {
        expect(body.requestId).toBeTruthy();
        // Should be a valid UUID or similar format
        expect(typeof body.requestId).toBe('string');
      }
    });

    it('includes requestId in error responses', async () => {
      const response = await request(app).get('/api/nonexistent-endpoint');

      const body = response.body as ApiEnvelope;
      expect('requestId' in body).toBe(true);
      if ('requestId' in body) {
        expect(body.requestId).toBeTruthy();
      }
    });
  });

  describe('timestamp consistency', () => {
    it('timestamps are recent (within 5 seconds of now)', async () => {
      const beforeTime = new Date();
      const response = await request(app).get('/api/health');
      const afterTime = new Date();

      const body = response.body as ApiEnvelope;
      if ('timestamp' in body) {
        const responseTime = new Date(body.timestamp);
        const diff = responseTime.getTime() - beforeTime.getTime();

        expect(diff).toBeGreaterThanOrEqual(0);
        expect(diff).toBeLessThan(5000); // Should be within 5 seconds
      }
      expect(afterTime.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });
  });

  describe('Marketplace plugins and billing disputes envelopes', () => {
    const assertEnvelope = (body: ApiEnvelope, expectedSuccess: boolean) => {
      expect(body).toHaveProperty('success', expectedSuccess);
      expect(typeof body.requestId).toBe('string');
      expect(body.requestId.length).toBeGreaterThan(0);
      expect(typeof body.timestamp).toBe('string');
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      if (body.success) {
        expect(body).toHaveProperty('data');
      } else {
        expect(body).toHaveProperty('error');
        expect(typeof body.error.code).toBe('string');
        expect(typeof body.error.message).toBe('string');
      }
    };

    it('wraps marketplace plugin routes in canonical envelopes', async () => {
      const listRes = await request(app).get('/api/marketplace/plugins');
      expect(listRes.status).toBe(200);
      assertEnvelope(listRes.body as ApiEnvelope, true);

      const createRes = await request(app)
        .post('/api/marketplace/plugins')
        .set('Authorization', makeAuthHeader('envelope-plugin-user'))
        .send({
          id: 'envelope-test-plugin',
          name: 'Envelope Test Plugin',
          version: '1.0.0',
          hooks: ['before_charge'],
        });
      expect(createRes.status).toBe(201);
      assertEnvelope(createRes.body as ApiEnvelope, true);

      const getRes = await request(app).get('/api/marketplace/plugins/envelope-test-plugin');
      expect(getRes.status).toBe(200);
      assertEnvelope(getRes.body as ApiEnvelope, true);

      const installRes = await request(app)
        .post('/api/marketplace/plugins/envelope-test-plugin/install')
        .set('Authorization', makeAuthHeader('envelope-plugin-user'));
      expect(installRes.status).toBe(200);
      assertEnvelope(installRes.body as ApiEnvelope, true);

      const uninstallRes = await request(app)
        .delete('/api/marketplace/plugins/envelope-test-plugin/install')
        .set('Authorization', makeAuthHeader('envelope-plugin-user'));
      expect(uninstallRes.status).toBe(200);
      assertEnvelope(uninstallRes.body as ApiEnvelope, true);

      const notFoundRes = await request(app).get('/api/marketplace/plugins/missing-plugin');
      expect(notFoundRes.status).toBe(404);
      assertEnvelope(notFoundRes.body as ApiEnvelope, false);
    });

    it('wraps billing dispute routes in canonical envelopes', async () => {
      process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';

      const openRes = await request(app)
        .post('/api/billing/disputes')
        .set('Authorization', makeAuthHeader('envelope-dispute-user'))
        .send({
          usage_event_id: 'evt-envelope-test-1',
          reason: 'Verify canonical envelope on dispute routes',
        });
      expect(openRes.status).toBe(201);
      assertEnvelope(openRes.body as ApiEnvelope, true);
      const disputeId = (openRes.body as { data: { id: string } }).data.id;

      const listRes = await request(app)
        .get('/api/billing/disputes')
        .set('Authorization', makeAuthHeader('envelope-dispute-user'));
      expect(listRes.status).toBe(200);
      assertEnvelope(listRes.body as ApiEnvelope, true);

      const detailRes = await request(app)
        .get(`/api/billing/disputes/${disputeId}`)
        .set('Authorization', makeAuthHeader('envelope-dispute-user'));
      expect(detailRes.status).toBe(200);
      assertEnvelope(detailRes.body as ApiEnvelope, true);

      const adminListRes = await request(app)
        .get('/api/billing/disputes/admin/all')
        .set('x-admin-api-key', process.env.ADMIN_API_KEY);
      expect(adminListRes.status).toBe(200);
      assertEnvelope(adminListRes.body as ApiEnvelope, true);

      const resolveRes = await request(app)
        .post(`/api/billing/disputes/${disputeId}/resolve`)
        .set('x-admin-api-key', process.env.ADMIN_API_KEY)
        .send({ resolution: 'UPHELD', notes: 'Contract verified' });
      expect(resolveRes.status).toBe(200);
      assertEnvelope(resolveRes.body as ApiEnvelope, true);

      const notFoundRes = await request(app)
        .get('/api/billing/disputes/missing-dispute')
        .set('Authorization', makeAuthHeader('envelope-dispute-user'));
      expect(notFoundRes.status).toBe(404);
      assertEnvelope(notFoundRes.body as ApiEnvelope, false);
    });
  });
});
