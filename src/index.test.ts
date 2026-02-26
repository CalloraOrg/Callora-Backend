import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import app from './index.js';

test('Health API returns ok status', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});
