/**
 * Integration tests for GET /api/metrics and the metricsMiddleware.
 *
 * Verifies:
 *   - Prometheus text output is served with the correct content-type
 *   - Auth gating works in production mode
 *   - http_requests_total and http_request_duration_seconds are recorded
 *     with the new route_group label after real HTTP requests
 *   - Concurrent requests do not cause errors
 */

import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetAllMetrics } from '../../src/metrics.js';

// Provide required env vars before any module that imports src/config/env.ts
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'test-admin-key';
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY ?? 'test-metrics-key';

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() {}
    close() {}
  };
});

describe('GET /api/metrics - Integration', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAllMetrics();
    app = createApp();
  });

  afterEach(() => {
    resetAllMetrics();
    // Restore NODE_ENV after production tests
    delete process.env.NODE_ENV;
  });

  // ── Basic endpoint behaviour ────────────────────────────────────────────────

  it('returns Prometheus content type', async () => {
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
    assert.match(res.text, /# HELP http_requests_total/);
  });

  it('exposes http_request_duration_seconds histogram', async () => {
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.match(res.text, /# HELP http_request_duration_seconds/);
    assert.match(res.text, /# TYPE http_request_duration_seconds histogram/);
  });

  it('does not error under concurrent requests', async () => {
    const requests = Array.from({ length: 10 }, () => request(app).get('/api/metrics'));
    const results = await Promise.all(requests);
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
      assert.match(res.text, /# HELP http_requests_total/);
    }
  });

  // ── Auth gating ─────────────────────────────────────────────────────────────

  it('returns 401 if METRICS_API_KEY is set and missing/invalid in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_API_KEY = 'testkey';
    app = createApp();
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 401);
    assert.match(res.text, /Unauthorized/);
  });

  it('returns 200 if METRICS_API_KEY is set and correct in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_API_KEY = 'testkey';
    app = createApp();
    const res = await request(app).get('/api/metrics').set('Authorization', 'Bearer testkey');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
  });

  // ── route_group label recording ─────────────────────────────────────────────

  it('records route_group="health" after a health request', async () => {
    await request(app).get('/api/health');
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.match(res.text, /route_group="health"/);
  });

  it('records route_group="metrics" after a metrics request', async () => {
    // First call records the metrics request itself
    await request(app).get('/api/metrics');
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.match(res.text, /route_group="metrics"/);
  });

  it('records route_group="other" for unknown routes', async () => {
    await request(app).get('/api/does-not-exist');
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.match(res.text, /route_group="other"/);
  });

  it('records route_group="apis" after a developer analytics request', async () => {
    // 401 is fine — we just want the metric to be recorded
    await request(app).get('/api/developers/analytics');
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.match(res.text, /route_group="apis"/);
  });

  // ── Cardinality protection ───────────────────────────────────────────────────

  it('does not store raw numeric IDs in route labels for 404s', async () => {
    await request(app).get('/api/unknown-area/99999');
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    // The route label must not contain the raw numeric ID
    assert.ok(!res.text.includes('route="/api/unknown-area/99999"'), 'raw numeric ID must not appear in route label');
    // The sanitized version should be present
    assert.match(res.text, /route="\/api\/unknown-area\/:id"/);
  });

  it('does not store raw UUIDs in route labels for 404s', async () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    await request(app).get(`/api/vault/${uuid}`);
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(`route="/api/vault/${uuid}"`), 'raw UUID must not appear in route label');
    assert.match(res.text, /route="\/api\/vault\/:uuid"/);
  });
});
