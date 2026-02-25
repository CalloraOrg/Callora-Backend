import request from 'supertest';
import app, { auditService } from './index.js';

describe('Health API', () => {
  beforeEach(() => {
    auditService.clearForTests();
  });

  it('should return ok status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('logs login with actor, action, resource, timestamp, and optional IP', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('x-forwarded-for', '203.0.113.42')
      .send({ user_id: 123 });

    expect(response.status).toBe(200);

    const logsResponse = await request(app)
      .get('/api/audit-logs')
      .query({ user_id: 123, action: 'user.login' });

    expect(logsResponse.status).toBe(200);
    expect(logsResponse.body.logs).toHaveLength(1);
    expect(logsResponse.body.logs[0]).toMatchObject({
      actorUserId: 123,
      action: 'user.login',
      resource: 'auth/session',
      ip: '203.0.113.42'
    });
    expect(logsResponse.body.logs[0].createdAt).toBeDefined();
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

    expect(logsResponse.status).toBe(200);
    expect(logsResponse.body.logs).toHaveLength(2);
    const serialized = JSON.stringify(logsResponse.body.logs);

    expect(serialized).toContain('api_key.create');
    expect(serialized).toContain('api_key.revoke');
    expect(serialized).toContain('pk_live_demo');
    expect(serialized).not.toContain('super-secret-raw-key-value');
    expect(serialized).not.toContain('another-secret-value');
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

    expect(logsResponse.status).toBe(200);
    expect(logsResponse.body.logs).toHaveLength(3);

    const actions = logsResponse.body.logs.map((log: { action: string }) => log.action);
    expect(actions).toEqual(
      expect.arrayContaining(['api.publish', 'api.update', 'settlement.run'])
    );
  });
});
