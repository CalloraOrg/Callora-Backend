process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';

import { jest } from '@jest/globals';

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => {
    return {
      prepare: jest.fn().mockReturnValue({ get: jest.fn() }),
      exec: jest.fn(),
      close: jest.fn(),
    };
  });
});

import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('Spike Route — Timeout (preserved)', () => {
  let app: any;

  beforeAll(() => {
    app = createApp();
  });

  it('should complete successfully (200 OK) when delay is smaller than timeout', async () => {
    const res = await request(app)
      .get('/api/spike?delay=100&timeout=500');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.delay).toBe(100);
  });

  it('should timeout (504 Gateway Timeout) when delay is larger than default timeout (1000ms)', async () => {
    const res = await request(app)
      .get('/api/spike?delay=1200'); // default timeout is 1000ms

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toBe('Request timeout exceeded');
  });

  it('should timeout (504 Gateway Timeout) when delay is larger than custom query timeout', async () => {
    const res = await request(app)
      .get('/api/spike?delay=500&timeout=200');

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toBe('Request timeout exceeded');
  });

  it('should support custom timeout via x-timeout-ms header', async () => {
    const res = await request(app)
      .get('/api/spike?delay=500')
      .set('x-timeout-ms', '200');

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toBe('Request timeout exceeded');
  });
});

describe('Spike Route — Mutation Audit Logging (Integration)', () => {
  let app: any;

  beforeAll(() => {
    app = createApp();
  });

  describe('POST /api/spike', () => {
    it('creates a spike record and returns 201 with full payload', async () => {
      const res = await request(app)
        .post('/api/spike')
        .send({ label: 'Test spike', severity: 'high' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        label: 'Test spike',
        severity: 'high',
      });
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
      expect(res.body.updatedAt).toBeDefined();
    });

    it('rejects missing label with 400', async () => {
      const res = await request(app)
        .post('/api/spike')
        .send({ severity: 'low' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });

    it('rejects invalid severity with 400', async () => {
      const res = await request(app)
        .post('/api/spike')
        .send({ label: 'Bad', severity: 'unknown' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/spike/:id', () => {
    let createdId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/spike')
        .send({ label: 'Before update', severity: 'low' })
        .set('Content-Type', 'application/json');
      createdId = res.body.id;
    });

    it('updates an existing spike record and returns 200', async () => {
      const res = await request(app)
        .put(`/api/spike/${createdId}`)
        .send({ label: 'After update', severity: 'critical' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: createdId,
        label: 'After update',
        severity: 'critical',
      });
    });

    it('returns 404 for non-existent record', async () => {
      const res = await request(app)
        .put('/api/spike/non-existent')
        .send({ label: 'Nope', severity: 'low' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/spike/:id', () => {
    let createdId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/spike')
        .send({ label: 'To delete', severity: 'medium' })
        .set('Content-Type', 'application/json');
      createdId = res.body.id;
    });

    it('deletes an existing spike record and returns 204', async () => {
      const res = await request(app).delete(`/api/spike/${createdId}`);
      expect(res.status).toBe(204);
    });

    it('returns 404 for non-existent record', async () => {
      const res = await request(app).delete('/api/spike/non-existent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/spike/records', () => {
    it('returns created spike records', async () => {
      await request(app)
        .post('/api/spike')
        .send({ label: 'List test', severity: 'high' })
        .set('Content-Type', 'application/json');

      const res = await request(app).get('/api/spike/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toBeInstanceOf(Array);
      expect(res.body.records.length).toBeGreaterThanOrEqual(1);
    });
  });
});
