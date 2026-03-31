import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetAllMetrics } from '../../src/metrics.js';

describe('GET /api/metrics - Integration', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    resetAllMetrics();
  });

  it('returns Prometheus content type', async () => {
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
    assert.match(res.text, /# HELP http_requests_total/);
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


  
  it('returns 401 if METRICS_API_KEY is set and missing/invalid', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_API_KEY = 'testkey';
    app = createApp();
    const res = await request(app).get('/api/metrics');
    assert.equal(res.status, 401);
    assert.match(res.text, /Unauthorized/);
  });
  it('returns 200 if METRICS_API_KEY is set and correct', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_API_KEY = 'testkey';
    app = createApp();
    const res = await request(app).get('/api/metrics').set('Authorization', 'Bearer testkey');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
  });
});
