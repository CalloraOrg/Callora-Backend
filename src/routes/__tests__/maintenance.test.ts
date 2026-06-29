import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { maintenanceRouter } from '../admin/maintenance';
import { healthzRouter } from '../../routes/healthz';

const app = express();
app.use(express.json());
app.use('/api/admin', maintenanceRouter);
app.use(healthzRouter);

describe('Maintenance Configuration & Health Tracking Integration', () => {
  
  it('should successfully modify operational parameters via the admin POST endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/maintenance')
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
      .send({ isEnabled: true });

    expect(res.status).toBe(400);
  });

  it('should surface a Service Unavailable 503 response header on /healthz when current time is in interval window', async () => {
    // Inject active global maintenance state boundaries
    await request(app)
      .post('/api/admin/maintenance')
      .send({
        isEnabled: true,
        startTime: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        endTime: new Date(Date.now() + 60000).toISOString(),  // 1 minute in the future
        reason: 'Emergency Patch.'
      });

    const healthCheckResponse = await request(app).get('/healthz');
    expect(healthCheckResponse.status).toBe(503);
    expect(healthCheckResponse.body.status).toBe('MAINTENANCE');
  });
});