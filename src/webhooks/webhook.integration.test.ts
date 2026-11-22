/**
 * Webhook Integration Tests
 * 
 * Tests the webhook endpoint integration with Express app
 */

jest.mock('../db.js', () => ({
  writeQuery: jest.fn().mockResolvedValue({ rows: [] }),
  readQuery: jest.fn().mockResolvedValue({ rows: [] }),
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  },
  closePgPool: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../db/index.js', () => ({
  initializeDb: jest.fn().mockResolvedValue(undefined),
  closeDb: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import app from '../index.js';
import { WebhookStore } from './webhook.store.js';
import {
  computeSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  SIGNATURE_TOLERANCE_MS,
} from './webhook.signature.js';

describe('Webhook Integration', () => {
  const TEST_SECRET = 'test-secret-key-at-least-32-characters-long';
  const DEVELOPER_ID = 'dev-integ-1';

  beforeEach(() => {
    WebhookStore.clear();
    WebhookStore.register({
      developerId: DEVELOPER_ID,
      url: 'https://example.com/webhook',
      events: ['payment.completed', 'new_api_call'],
      secret_current: TEST_SECRET,
      createdAt: new Date(),
    });
  });

  const createValidPayload = () => ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    event: 'payment.completed',
    timestamp: new Date().toISOString(),
    data: {
      amount: 1000,
      currency: 'USD',
      transactionId: 'tx_123456',
    },
  });

  const sign = (secret: string, timestamp: string, body: string, nonce: string) => {
    return `sha256=${computeSignature(secret, timestamp, body, nonce)}`;
  };

  describe('POST /api/webhooks/deliver/:developerId', () => {
    it('should accept valid webhook with correct signature', async () => {
      const payload = createValidPayload();
      const timestamp = new Date().toISOString();
      const nonceVal = 'nonce-valid-0123456789abcdef';
      const body = JSON.stringify(payload);
      const signature = sign(TEST_SECRET, timestamp, body, nonceVal);

      const response = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature)
        .set(TIMESTAMP_HEADER, timestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Webhook delivery accepted.');
      expect(response.body.body).toEqual(payload);
    });

    it('should reject webhook with missing signature', async () => {
      const payload = createValidPayload();
      const timestamp = new Date().toISOString();
      const nonceVal = 'nonce-missing-sig-0123456789';
      const body = JSON.stringify(payload);

      const response = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(TIMESTAMP_HEADER, timestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.error?.code ?? response.body.code).toBe('MISSING_WEBHOOK_SIGNATURE_HEADERS');
    });

    it('should reject webhook with invalid signature', async () => {
      const payload = createValidPayload();
      const timestamp = new Date().toISOString();
      const nonceVal = 'nonce-invalid-sig-012345678';
      const body = JSON.stringify(payload);

      const response = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, 'sha256=' + '0'.repeat(64))
        .set(TIMESTAMP_HEADER, timestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.error?.code ?? response.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('should reject webhook with missing timestamp', async () => {
      const payload = createValidPayload();
      const timestamp = new Date().toISOString();
      const nonceVal = 'nonce-no-timestamp-01234567';
      const body = JSON.stringify(payload);
      const signature = sign(TEST_SECRET, timestamp, body, nonceVal);

      const response = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.error?.code ?? response.body.code).toBe('MISSING_WEBHOOK_SIGNATURE_HEADERS');
    });

    it('should reject expired webhook', async () => {
      const payload = createValidPayload();
      const staleTimestamp = new Date(Date.now() - SIGNATURE_TOLERANCE_MS - 5000).toISOString();
      const nonceVal = 'nonce-expired-0123456789ab';
      const body = JSON.stringify(payload);
      const signature = sign(TEST_SECRET, staleTimestamp, body, nonceVal);

      const response = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature)
        .set(TIMESTAMP_HEADER, staleTimestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.error?.code ?? response.body.code).toBe('WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
    });

    it('should reject webhook with tampered payload', async () => {
      const payload = createValidPayload();
      const timestamp = new Date().toISOString();
      const nonceVal = 'nonce-tampered-0123456789';
      const originalBody = JSON.stringify(payload);
      const signature = sign(TEST_SECRET, timestamp, originalBody, nonceVal);

      const tamperedPayload = { ...payload, data: { ...payload.data, amount: 9999 } };
      const tamperedBody = JSON.stringify(tamperedPayload);

      const response = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature)
        .set(TIMESTAMP_HEADER, timestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(tamperedBody);

      expect(response.status).toBe(401);
      expect(response.body.error?.code ?? response.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('should reject webhook with reused nonce (replay)', async () => {
      const payload = createValidPayload();
      const timestamp = new Date().toISOString();
      const nonceVal = 'nonce-replay-0123456789abc';
      const body = JSON.stringify(payload);
      const signature = sign(TEST_SECRET, timestamp, body, nonceVal);

      const response1 = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature)
        .set(TIMESTAMP_HEADER, timestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response1.status).toBe(200);

      const response2 = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature)
        .set(TIMESTAMP_HEADER, timestamp)
        .set(NONCE_HEADER, nonceVal)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response2.status).toBe(401);
      expect(response2.body.error?.code ?? response2.body.code).toBe('WEBHOOK_NONCE_REPLAYED');
    });

    it('should handle multiple valid webhooks sequentially', async () => {
      const payload1 = createValidPayload();
      payload1.id = '550e8400-e29b-41d4-a716-446655440001';
      const timestamp1 = new Date().toISOString();
      const nonce1 = 'nonce-seq-1-0123456789abcd';
      const body1 = JSON.stringify(payload1);
      const signature1 = sign(TEST_SECRET, timestamp1, body1, nonce1);

      const payload2 = createValidPayload();
      payload2.id = '550e8400-e29b-41d4-a716-446655440002';
      const timestamp2 = new Date().toISOString();
      const nonce2 = 'nonce-seq-2-0123456789abcd';
      const body2 = JSON.stringify(payload2);
      const signature2 = sign(TEST_SECRET, timestamp2, body2, nonce2);

      const response1 = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature1)
        .set(TIMESTAMP_HEADER, timestamp1)
        .set(NONCE_HEADER, nonce1)
        .set('Content-Type', 'application/json')
        .send(body1);

      const response2 = await request(app)
        .post(`/api/webhooks/deliver/${DEVELOPER_ID}`)
        .set(SIGNATURE_HEADER, signature2)
        .set(TIMESTAMP_HEADER, timestamp2)
        .set(NONCE_HEADER, nonce2)
        .set('Content-Type', 'application/json')
        .send(body2);

      expect(response1.status).toBe(200);
      expect(response1.body.body.id).toBe(payload1.id);
      expect(response2.status).toBe(200);
      expect(response2.body.body.id).toBe(payload2.id);
    });
  });

  describe('Other endpoints', () => {
    it('should not affect health check endpoint', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('ok');
    });

    it('should not affect apis endpoint', async () => {
      const response = await request(app).get('/api/apis');

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should not affect usage endpoint', async () => {
      const response = await request(app).get('/api/usage');

      expect([200, 401]).toContain(response.status);
    });
  });
});
