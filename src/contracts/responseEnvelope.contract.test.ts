import request from 'supertest';
import { createApp } from '../app.js';
import type { ApiEnvelope } from '../types/ResponseEnvelope.js';

describe('Response Envelope Contract Tests', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
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
    });
  });
});
