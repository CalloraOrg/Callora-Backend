import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../db.js', () => ({
  writeQuery: jest.fn(),
}));

jest.mock('../logger.js', () => {
  const actual = jest.requireActual('../logger.js');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      audit: jest.fn(),
    },
  };
});

import { writeQuery } from '../db.js';
import app from '../index.js';
import { WebhookStore } from '../webhooks/webhook.store.js';

const mockWriteQuery = writeQuery as jest.MockedFunction<typeof writeQuery>;

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';

function authHeader(developerId: string) {
  const token = jwt.sign({ userId: developerId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

function adminAuthHeader() {
  return { 'x-admin-api-key': ADMIN_API_KEY };
}

function adminJwtHeader(sub = 'admin-user-1') {
  const token = jwt.sign({ role: 'admin', sub }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

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
        .set(authHeader('dev-test-1'))
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
        .set(authHeader('dev-test-2'))
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
        .set(authHeader('dev-rotate-1'))
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
        .set(authHeader('dev-retry-1'))
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
        .delete('/api/webhooks/dev-delete-1')
        .set(authHeader('dev-delete-1'));

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
        .delete('/api/webhooks/dev-delete-nonexistent')
        .set(authHeader('dev-delete-nonexistent'));

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
        .get('/api/webhooks/dev-get-1')
        .set(authHeader('dev-get-1'));

      assert.equal(response.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 0);
    });
  });
});

describe('Webhook management routes — Authentication & Authorization (Issue #1254)', () => {
  beforeEach(() => {
    mockWriteQuery.mockResolvedValue({ rows: [] });
    WebhookStore.clear();

    WebhookStore.register({
      developerId: 'dev-bob',
      url: 'https://example.com/bob-hook',
      events: ['new_api_call'],
      secret_current: 'bob-secret-must-be-at-least-32-chars-long',
      createdAt: new Date(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Acceptance Criterion 1: Unauthenticated requests return 401', () => {
    it('returns 401 for unauthenticated POST /api/webhooks', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .send({
          developerId: 'dev-alice',
          url: 'https://example.com/webhook',
          events: ['new_api_call'],
        });
      assert.equal(res.status, 401);
    });

    it('returns 401 for unauthenticated GET /api/webhooks/:developerId', async () => {
      const res = await request(app).get('/api/webhooks/dev-bob');
      assert.equal(res.status, 401);
    });

    it('returns 401 for unauthenticated POST /api/webhooks/:developerId/rotate-secret', async () => {
      const res = await request(app).post('/api/webhooks/dev-bob/rotate-secret').send({});
      assert.equal(res.status, 401);
    });

    it('returns 401 for unauthenticated DELETE /api/webhooks/:developerId', async () => {
      const res = await request(app).delete('/api/webhooks/dev-bob');
      assert.equal(res.status, 401);
    });

    it('returns 401 for unauthenticated PATCH /api/webhooks/:developerId/retry-policy', async () => {
      const res = await request(app)
        .patch('/api/webhooks/dev-bob/retry-policy')
        .send({ retryPolicy: { maxRetries: 3 } });
      assert.equal(res.status, 401);
    });
  });

  describe('Acceptance Criterion 2: User manipulating another developer webhook gets 403', () => {
    it('returns 403 when dev-alice tries to GET dev-bob webhook', async () => {
      const res = await request(app)
        .get('/api/webhooks/dev-bob')
        .set(authHeader('dev-alice'));
      assert.equal(res.status, 403);
    });

    it('returns 403 when dev-alice tries to register a webhook for dev-bob', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .set(authHeader('dev-alice'))
        .send({
          developerId: 'dev-bob',
          url: 'https://evil.com/redirect',
          events: ['new_api_call'],
        });
      assert.equal(res.status, 403);
    });

    it('returns 403 when dev-alice tries to rotate-secret for dev-bob', async () => {
      const res = await request(app)
        .post('/api/webhooks/dev-bob/rotate-secret')
        .set(authHeader('dev-alice'))
        .send({});
      assert.equal(res.status, 403);
    });

    it('returns 403 when dev-alice tries to DELETE dev-bob webhook', async () => {
      const res = await request(app)
        .delete('/api/webhooks/dev-bob')
        .set(authHeader('dev-alice'));
      assert.equal(res.status, 403);
      // Verify dev-bob webhook was not deleted
      assert.ok(WebhookStore.get('dev-bob'));
    });

    it('returns 403 when dev-alice tries to PATCH dev-bob retry policy', async () => {
      const res = await request(app)
        .patch('/api/webhooks/dev-bob/retry-policy')
        .set(authHeader('dev-alice'))
        .send({ retryPolicy: { maxRetries: 1 } });
      assert.equal(res.status, 403);
    });
  });

  describe('Acceptance Criterion 3: rotate-secret only returns secret to owner', () => {
    it('returns new secret to owner on valid rotation', async () => {
      const res = await request(app)
        .post('/api/webhooks/dev-bob/rotate-secret')
        .set(authHeader('dev-bob'))
        .send({});

      assert.equal(res.status, 200);
      assert.equal(res.body.developerId, 'dev-bob');
      assert.equal(typeof res.body.secret, 'string');
      assert.equal(res.body.secret.length, 64);

      // Verify the store updated
      const updated = WebhookStore.get('dev-bob');
      assert.equal(updated?.secret_current, res.body.secret);
      assert.equal(updated?.secret_previous, 'bob-secret-must-be-at-least-32-chars-long');
    });

    it('does NOT rotate or return secret when non-owner requests rotation', async () => {
      const beforeSecret = WebhookStore.get('dev-bob')?.secret_current;

      const res = await request(app)
        .post('/api/webhooks/dev-bob/rotate-secret')
        .set(authHeader('dev-intruder'))
        .send({});

      assert.equal(res.status, 403);
      assert.equal(res.body.secret, undefined);

      // Verify the secret in store remained unchanged
      const afterSecret = WebhookStore.get('dev-bob')?.secret_current;
      assert.equal(afterSecret, beforeSecret);
    });
  });

  describe('Acceptance Criterion 4: Audit rows record authenticated actor rather than path parameter', () => {
    it('records authenticated actor on webhook registration even if path/body differs', async () => {
      const res = await request(app)
        .post('/api/webhooks')
        .set(authHeader('dev-authenticated'))
        .send({
          url: 'https://example.com/registered',
          events: ['new_api_call'],
        });

      assert.equal(res.status, 201);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_REGISTERED');
      assert.equal(params[2], 'dev-authenticated'); // Authenticated user is the actor
    });

    it('records adminActor in audit log when action is performed by admin', async () => {
      const res = await request(app)
        .post('/api/webhooks/dev-bob/rotate-secret')
        .set(adminAuthHeader())
        .send({});

      assert.equal(res.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_SECRET_ROTATED');
      assert.equal(params[2], 'admin-api-key'); // Authenticated admin actor, NOT dev-bob
    });

    it('records admin sub in audit log when action is performed by admin JWT', async () => {
      const res = await request(app)
        .delete('/api/webhooks/dev-bob')
        .set(adminJwtHeader('admin-operator-42'));

      assert.equal(res.status, 200);
      assert.equal(mockWriteQuery.mock.calls.length, 1);

      const call = mockWriteQuery.mock.calls[0]!;
      const params = call[1] as unknown[];
      assert.equal(params[1], 'WEBHOOK_DELETED');
      assert.equal(params[2], 'admin-operator-42');
    });
  });

  describe('Admin access via adminAuth', () => {
    it('allows admin with API key to GET another developer webhook', async () => {
      const res = await request(app)
        .get('/api/webhooks/dev-bob')
        .set(adminAuthHeader());

      assert.equal(res.status, 200);
      assert.equal(res.body.developerId, 'dev-bob');
    });

    it('allows admin with admin JWT to GET another developer webhook', async () => {
      const res = await request(app)
        .get('/api/webhooks/dev-bob')
        .set(adminJwtHeader());

      assert.equal(res.status, 200);
      assert.equal(res.body.developerId, 'dev-bob');
    });
  });
});