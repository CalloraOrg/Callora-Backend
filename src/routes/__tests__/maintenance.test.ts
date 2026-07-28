import express from 'express';
import request from 'supertest';
import { maintenanceRouter } from '../admin/maintenance.js';
import { healthzRouter } from '../healthz.js';

// Set expected origin so CORS middleware permits the test requests
process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS = 'http://localhost:5173,https://admin.callora.dev';

const app = express();
app.use(express.json());
app.use('/api/admin', maintenanceRouter);
app.use(healthzRouter);

describe('Maintenance Configuration & Health Tracking Integration', () => {

  const origin = 'http://localhost:5173';

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

  it('should reject requests missing crucial window fields when activation is set to true', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Origin', origin)
      .send({ isEnabled: true });

    expect(res.status).toBe(400);
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
});
