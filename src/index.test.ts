import request from 'supertest';
import app, { auditService } from './index.js';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

describe('Health API', () => {
  beforeEach(() => {
    auditService.clearForTests();
  });

  it('should return ok status', async () => {
    const response = await request(app).get('/api/health');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'ok');
  });

  it('logs login with actor, action, resource, timestamp, and optional IP', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('x-forwarded-for', '203.0.113.42')
      .send({ user_id: 123 });

    assert.strictEqual(response.status, 200);

    const logsResponse = await request(app)
      .get('/api/audit-logs')
      .query({ user_id: 123, action: 'user.login' });

    assert.strictEqual(logsResponse.status, 200);
    assert.strictEqual(logsResponse.body.logs.length, 1);
    const log = logsResponse.body.logs[0];
    assert.strictEqual(log.actorUserId, 123);
    assert.strictEqual(log.action, 'user.login');
    assert.strictEqual(log.resource, 'auth/session');
    assert.strictEqual(log.ip, '203.0.113.42');
    assert.ok(log.createdAt);
  });

  it('logs api key create/revoke without logging full secret values', async () => {
    await request(app).post('/api/keys').send({
      user_id: 9,
      api_id: 42,
      prefix: 'pk_live_demo',
      api_key: 'super-secret-raw-key-value'
    });

    await request(app)
      .post('/api/keys/42/revoke')
      .send({
        user_id: 9,
        prefix: 'pk_live_demo',
        raw_key: 'another-secret-value'
      });

    const logsResponse = await request(app)
      .get('/api/audit-logs')
      .query({ user_id: 9 });

    assert.strictEqual(logsResponse.status, 200);
    assert.strictEqual(logsResponse.body.logs.length, 2);
    const serialized = JSON.stringify(logsResponse.body.logs);

    assert.ok(serialized.includes('api_key.create'));
    assert.ok(serialized.includes('api_key.revoke'));
    assert.ok(serialized.includes('pk_live_demo'));
    assert.ok(!serialized.includes('super-secret-raw-key-value'));
    assert.ok(!serialized.includes('another-secret-value'));
  });

  it('logs API publish/update and settlement run actions', async () => {
    await request(app).post('/api/apis/17/publish').send({ user_id: 77 });
    await request(app).put('/api/apis/17').send({ user_id: 77 });
    await request(app)
      .post('/api/settlements/run')
      .send({ user_id: 77, run_id: 'run-2026-02-25' });

    const logsResponse = await request(app)
      .get('/api/audit-logs')
      .query({ user_id: 77 });

    assert.strictEqual(logsResponse.status, 200);
    assert.strictEqual(logsResponse.body.logs.length, 3);

    const actions = logsResponse.body.logs.map((log: { action: string }) => log.action);
    assert.ok(actions.includes('api.publish'));
    assert.ok(actions.includes('api.update'));
    assert.ok(actions.includes('settlement.run'));
  });
});
