import express from 'express';
import request from 'supertest';
import { maintenanceRouter } from '../admin/maintenance.js';
import { healthzRouter } from '../healthz.js';
import publicMaintenanceRouter from '../maintenance.js';
import { createMaintenanceCorsMiddleware } from '../../middleware/cors.js';

const originalAllowedOrigins = process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS = 'http://localhost:5173,https://admin.callora.dev';

const app = express();
app.use(express.json());
app.use('/api/admin', maintenanceRouter);
app.use('/api/maintenance', publicMaintenanceRouter);
app.use(healthzRouter);

describe('Maintenance Configuration & Health Tracking Integration', () => {

  const origin = 'http://localhost:5173';

  afterEach(async () => {
    await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: false })
      .expect(200);
  });

  afterAll(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
    } else {
      process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  it('should successfully modify operational parameters via the admin POST endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-12-31T23:59:59.000Z',
        reason: 'Database scaling upgrade.'
      });

    expect(res.status).toBe(200);
    expect(res.body.data.isEnabled).toBe(true);
  });

  it('should reject a non-boolean isEnabled value with an explicit error', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: 'true' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Property "isEnabled" must be an explicit boolean value.',
    );
  });

  it('should reject requests missing crucial window fields when activation is set to true', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'startTime and endTime ISO parameters are mandatory when maintenance is active.',
    );
  });

  it.each([
    ['numeric startTime', '2020', '2026-01-02T00:00:00.000Z'],
    ['unparsable startTime', 'not-a-date', '2026-01-02T00:00:00.000Z'],
    ['unparsable endTime', '2026-01-01T00:00:00.000Z', 'not-a-date'],
  ])('should reject an invalid %s value', async (_label, startTime, endTime) => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: true, startTime, endTime });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Invalid ISO date strings provided for tracking windows.',
    );
  });

  it('should normalize ISO dates and return the latest state from GET', async () => {
    const post = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: '2026-01-01T01:00:00+01:00',
        endTime: '2026-01-02T01:00:00+01:00',
        reason: 'Scheduled deployment',
      });

    expect(post.status).toBe(200);
    expect(post.body.data).toMatchObject({
      isEnabled: true,
      startTime: new Date('2026-01-01T01:00:00+01:00').toISOString(),
      endTime: new Date('2026-01-02T01:00:00+01:00').toISOString(),
      reason: 'Scheduled deployment',
    });

    const get = await request(app)
      .get('/api/admin/maintenance')
      .set('Origin', origin);

    expect(get.status).toBe(200);
    expect(get.body.data).toEqual(post.body.data);
  });

  it('should accept a startTime after endTime as it currently does', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: '2026-01-02T00:00:00.000Z',
        endTime: '2026-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.startTime).toBe('2026-01-02T00:00:00.000Z');
    expect(res.body.data.endTime).toBe('2026-01-01T00:00:00.000Z');
  });

  it('should use the default reason when reason is an empty string', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-02T00:00:00.000Z',
        reason: '',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.reason).toBe('Scheduled infrastructure updates.');
  });

  it('should clear the window and return health and public status to normal when disabled', async () => {
    await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: new Date(Date.now() - 60000).toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString(),
        reason: 'Emergency patch',
      })
      .expect(200);

    const disabled = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: false });

    expect(disabled.status).toBe(200);
    expect(disabled.body.data).toEqual({
      isEnabled: false,
      startTime: null,
      endTime: null,
      reason: 'Scheduled infrastructure updates.',
    });

    const adminStatus = await request(app)
      .get('/api/admin/maintenance')
      .set('Origin', origin);
    expect(adminStatus.status).toBe(200);
    expect(adminStatus.body.data).toEqual(disabled.body.data);

    const publicStatus = await request(app)
      .get('/api/maintenance')
      .set('Origin', origin);
    expect(publicStatus.status).toBe(200);
    expect(publicStatus.body.data).toEqual(disabled.body.data);

    const healthCheck = await request(app).get('/healthz');
    expect(healthCheck.status).toBe(200);
    expect(healthCheck.body.status).toBe('ok');
  });

  it('should use the default reason when maintenance is disabled', async () => {
    await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-02T00:00:00.000Z',
        reason: 'Custom reason',
      })
      .expect(200);

    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: false, reason: 'Custom reason' });

    expect(res.status).toBe(200);
    expect(res.body.data.reason).toBe('Scheduled infrastructure updates.');
  });

  it('should surface a Service Unavailable 503 response header on /healthz when current time is in interval window', async () => {
    await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({
        isEnabled: true,
        startTime: new Date(Date.now() - 60000).toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString(),
        reason: 'Emergency Patch.'
      });

    const healthCheckResponse = await request(app).get('/healthz');
    expect(healthCheckResponse.status).toBe(503);
    expect(healthCheckResponse.body.status).toBe('MAINTENANCE');
  });

  it('should include correlationId in POST response when x-correlation-id header is provided', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .set('x-correlation-id', 'test-corr-456')
      .send({
        isEnabled: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('test-corr-456');
  });

  it('should include correlationId in GET response when x-correlation-id header is provided', async () => {
    const res = await request(app)
      .get('/api/admin/maintenance')
      .set('Origin', origin)
      .set('x-correlation-id', 'get-corr-789');

    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('get-corr-789');
  });

  it('should include correlationId in error responses', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .set('x-correlation-id', 'error-corr-111')
      .send({ isEnabled: true });

    expect(res.status).toBe(400);
    expect(res.body.correlationId).toBe('error-corr-111');
  });

  it('should set X-Correlation-Id response header', async () => {
    const res = await request(app)
      .get('/api/admin/maintenance')
      .set('Origin', origin);

    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('should echo X-Correlation-Id response header when client sends it', async () => {
    const res = await request(app)
      .get('/api/admin/maintenance')
      .set('Origin', origin)
      .set('x-correlation-id', 'echo-corr-222');

    expect(res.headers['x-correlation-id']).toBe('echo-corr-222');
  });

  it('should reject origins outside the configured allowlist', async () => {
    const res = await request(app)
      .get('/api/admin/maintenance')
      .set('Origin', 'https://unlisted.example.com');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('should return 204 for an allowlisted preflight request', async () => {
    const res = await request(app)
      .options('/api/admin/maintenance')
      .set('Origin', origin);

    expect(res.status).toBe(204);
  });

  it('should deny all origins when the maintenance CORS allowlist is unset', async () => {
    const original = process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
    delete process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
    const corsApp = express();
    corsApp.use(createMaintenanceCorsMiddleware());
    corsApp.get('/maintenance', (_req, res) => res.sendStatus(200));

    try {
      const get = await request(corsApp)
        .get('/maintenance')
        .set('Origin', origin);
      expect(get.status).toBe(403);
      expect(get.body.error.code).toBe('ORIGIN_NOT_ALLOWED');

      const preflight = await request(corsApp)
        .options('/maintenance')
        .set('Origin', origin);
      expect(preflight.status).toBe(403);
    } finally {
      if (original === undefined) {
        delete process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
      } else {
        process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS = original;
      }
    }
  });
});
