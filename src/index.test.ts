import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import app from './index.js';

test('Health API returns ok status', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

describe('POST /api/apis/:apiId/keys', () => {
  it('creates an API key for an authenticated user and returns key + prefix once', async () => {
    const response = await request(app)
      .post('/api/apis/weather-api/keys')
      .set('authorization', 'Bearer user-123')
      .send({
        scopes: ['read:usage'],
        rate_limit_per_minute: 120
      });

    assert.equal(response.status, 201);
    assert.ok(response.body.key);
    assert.ok(response.body.prefix);
    assert.ok(response.body.key.startsWith('ck_live_'));
    assert.ok(response.body.key.startsWith(response.body.prefix));

    const stored = apiKeyRepository.listForTesting().at(-1);
    assert.equal(stored?.prefix, response.body.prefix);
    assert.ok(stored?.keyHash);
    assert.equal((stored as unknown as { key?: string })?.key, undefined);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await request(app).post('/api/apis/weather-api/keys').send({});
    assert.equal(response.status, 401);
  });

  it('returns 400 when scopes are invalid', async () => {
    const response = await request(app)
      .post('/api/apis/weather-api/keys')
      .set('authorization', 'Bearer user-123')
      .send({ scopes: [123] });

    assert.equal(response.status, 400);
  });

  it('returns 400 when rate_limit_per_minute is invalid', async () => {
    const response = await request(app)
      .post('/api/apis/weather-api/keys')
      .set('authorization', 'Bearer user-123')
      .send({ rate_limit_per_minute: 0 });

    assert.equal(response.status, 400);
  });

  it('returns 404 when API is not published and active', async () => {
    const draftApiResponse = await request(app)
      .post('/api/apis/draft-api/keys')
      .set('authorization', 'Bearer user-123')
      .send({});

    const inactiveApiResponse = await request(app)
      .post('/api/apis/inactive-api/keys')
      .set('authorization', 'Bearer user-123')
      .send({});

    const missingApiResponse = await request(app)
      .post('/api/apis/missing-api/keys')
      .set('authorization', 'Bearer user-123')
      .send({});

    assert.equal(draftApiResponse.status, 404);
    assert.equal(inactiveApiResponse.status, 404);
    assert.equal(missingApiResponse.status, 404);
  });
});
