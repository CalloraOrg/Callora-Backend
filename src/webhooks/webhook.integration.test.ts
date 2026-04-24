/**
 * Webhook Integration Tests
 * 
 * Tests the webhook endpoint integration with Express app
 */

import request from 'supertest';
import crypto from 'crypto';
import app from '../index.js';

describe('Webhook Integration', () => {
  const TEST_SECRET = process.env.WEBHOOK_SECRET ?? 'default-secret-key-at-least-32-characters-long-change-in-production';

  // Helper function to create a valid webhook payload
  const createValidPayload = () => ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    event: 'payment.completed',
    timestamp: Math.floor(Date.now() / 1000),
    data: {
      amount: 1000,
      currency: 'USD',
      transactionId: 'tx_123456',
    },
  });

  // Helper function to compute signature
  const computeSignature = (timestamp: string, body: string): string => {
    const signedPayload = `${timestamp}.${body}`;
    return crypto
      .createHmac('sha256', TEST_SECRET)
      .update(signedPayload)
      .digest('hex');
  };

  describe('POST /api/webhooks', () => {
    it('should accept valid webhook with correct signature', async () => {
      const payload = createValidPayload();
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);
      const signature = computeSignature(timestamp, body);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature)
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.eventId).toBe(payload.id);
      expect(response.body.eventType).toBe(payload.event);
    });

    it('should reject webhook with missing signature', async () => {
      const payload = createValidPayload();
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Webhook validation failed');
    });

    it('should reject webhook with invalid signature', async () => {
      const payload = createValidPayload();
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', 'invalid-signature')
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should reject webhook with missing timestamp', async () => {
      const payload = createValidPayload();
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);
      const signature = computeSignature(timestamp, body);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should reject expired webhook', async () => {
      const payload = createValidPayload();
      // Set timestamp to 10 minutes ago (maxAge is 5 minutes)
      payload.timestamp = Math.floor(Date.now() / 1000) - 600;
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);
      const signature = computeSignature(timestamp, body);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature)
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('expired');
    });

    it('should reject webhook with tampered payload', async () => {
      const payload = createValidPayload();
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);
      const signature = computeSignature(timestamp, body);

      // Tamper with payload
      const tamperedPayload = { ...payload, data: { ...payload.data, amount: 9999 } };
      const tamperedBody = JSON.stringify(tamperedPayload);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature)
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(tamperedBody);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should reject webhook with invalid JSON', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = '{ invalid json }';
      const signature = computeSignature(timestamp, body);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature)
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should reject webhook with missing required fields', async () => {
      const payload = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        // Missing 'event' field
        timestamp: Math.floor(Date.now() / 1000),
        data: { test: 'data' },
      };
      const timestamp = payload.timestamp.toString();
      const body = JSON.stringify(payload);
      const signature = computeSignature(timestamp, body);

      const response = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature)
        .set('x-webhook-timestamp', timestamp)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should handle multiple valid webhooks sequentially', async () => {
      const payload1 = createValidPayload();
      payload1.id = '550e8400-e29b-41d4-a716-446655440001';
      const timestamp1 = payload1.timestamp.toString();
      const body1 = JSON.stringify(payload1);
      const signature1 = computeSignature(timestamp1, body1);

      const payload2 = createValidPayload();
      payload2.id = '550e8400-e29b-41d4-a716-446655440002';
      const timestamp2 = payload2.timestamp.toString();
      const body2 = JSON.stringify(payload2);
      const signature2 = computeSignature(timestamp2, body2);

      const response1 = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature1)
        .set('x-webhook-timestamp', timestamp1)
        .set('Content-Type', 'application/json')
        .send(body1);

      const response2 = await request(app)
        .post('/api/webhooks')
        .set('x-webhook-signature', signature2)
        .set('x-webhook-timestamp', timestamp2)
        .set('Content-Type', 'application/json')
        .send(body2);

      expect(response1.status).toBe(200);
      expect(response1.body.eventId).toBe(payload1.id);
      expect(response2.status).toBe(200);
      expect(response2.body.eventId).toBe(payload2.id);
    });
  });

  describe('Other endpoints', () => {
    it('should not affect health check endpoint', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });

    it('should not affect apis endpoint', async () => {
      const response = await request(app).get('/api/apis');

      expect(response.status).toBe(200);
      expect(response.body.apis).toBeDefined();
    });

    it('should not affect usage endpoint', async () => {
      const response = await request(app).get('/api/usage');

      expect(response.status).toBe(200);
      expect(response.body.calls).toBeDefined();
    });
  });
});
