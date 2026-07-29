import assert from 'node:assert/strict';
import request from 'supertest';

jest.mock('../db.js', () => ({
  writeQuery: jest.fn(),
}));

jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    audit: jest.fn(),
  },
}));

import { writeQuery } from '../db.js';
import app from '../index.js';
import { WebhookStore } from '../webhooks/webhook.store.js';

const mockWriteQuery = writeQuery as jest.MockedFunction<typeof writeQuery>;

describe('Webhook routes — audit persistence', () => {
  beforeEach(() => {
    mockWriteQuery.mockResolvedValue({ rows: [] });
    WebhookStore.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/webhooks — register', () => {
    it('persists an audit row for webhook registration', async () => {
      const response = await request(app)
        .post('/api/webhooks')
        .send({
          developerId: 'dev-test-1',
          url: 'https://example.com/webhook',
          events: ['new_api_call'],
        });

      assert.equal(response.status, 201);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const sql = call[0] as string;
      const params = call[1] as unknown[];
      assert.ok(sql.includes('INSERT INTO audit_logs'));
      assert.equal(params[1], 'WEBHOOK_REGISTERED');
      assert.equal(params[2], 'dev-test-1');

      const details = JSON.parse(params[8] as string);
      assert.ok(details.after);
      assert.equal(details.after.developerId, 'dev-test-1');
      assert.equal(details.after.url, 'https://example.com/webhook');
    });

    it('persists before as undefined when no existing webhook', async () => {
      await request(app)
        .post('/api/webhooks')
        .send({
          developerId: 'dev-test-2',
          url: 'https://example.com/webhook',
          events: ['new_api_call'],
        });

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      const details = JSON.parse(params[8] as string);
      assert.equal(details.before, undefined);
    });
  });

  describe('POST /api/webhooks/:developerId/rotate-secret', () => {
    it('persists an audit row for secret rotation', async () => {
      WebhookStore.register({
        developerId: 'dev-rotate-1',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        secret_current: 'old-secret-key-at-least-32-chars',
        createdAt: new Date(),
      });

      const response = await request(app)
        .post('/api/webhooks/dev-rotate-1/rotate-secret')
        .send({});

      assert.equal(response.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_SECRET_ROTATED');
      assert.equal(params[2], 'dev-rotate-1');

      const details = JSON.parse(params[8] as string);
      assert.ok(details.before);
      assert.ok(details.after);
    });
  });

  describe('PATCH /api/webhooks/:developerId/retry-policy', () => {
    it('persists an audit row for retry policy update', async () => {
      WebhookStore.register({
        developerId: 'dev-retry-1',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        createdAt: new Date(),
      });

      const response = await request(app)
        .patch('/api/webhooks/dev-retry-1/retry-policy')
        .send({
          retryPolicy: { maxRetries: 3, baseDelayMs: 1000 },
        });

      assert.equal(response.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_RETRY_POLICY_UPDATED');
      assert.equal(params[2], 'dev-retry-1');

      const details = JSON.parse(params[8] as string);
      assert.ok(details.before);
      assert.ok(details.after);
    });
  });

  describe('DELETE /api/webhooks/:developerId', () => {
    it('persists an audit row for webhook deletion with before state', async () => {
      WebhookStore.register({
        developerId: 'dev-delete-1',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        secret_current: 'secret-key-at-least-32-chars-long',
        createdAt: new Date(),
      });

      const response = await request(app)
        .delete('/api/webhooks/dev-delete-1');

      assert.equal(response.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_DELETED');
      assert.equal(params[2], 'dev-delete-1');

      const details = JSON.parse(params[8] as string);
      assert.ok(details.before);
      assert.equal(details.before.developerId, 'dev-delete-1');
      assert.equal(details.after, undefined);
    });

    it('persists an audit row with null before when webhook does not exist', async () => {
      const response = await request(app)
        .delete('/api/webhooks/dev-delete-nonexistent');

      assert.equal(response.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_DELETED');
      assert.equal(params[2], 'dev-delete-nonexistent');
    });
  });

  describe('GET /api/webhooks/:developerId — non-state-changing', () => {
    it('does NOT persist an audit row for GET requests', async () => {
      WebhookStore.register({
        developerId: 'dev-get-1',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        createdAt: new Date(),
      });

      const response = await request(app)
        .get('/api/webhooks/dev-get-1');

      assert.equal(response.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 0);
    });
  });
});