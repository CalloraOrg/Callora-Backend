import assert from 'node:assert/strict';
import request from 'supertest';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));
jest.mock('./services/transactionBuilder.js', () => ({
  TransactionBuilderService: class MockTxBuilder {},
}));
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

import { createApp } from './app.js';
import type { Developer } from './db/schema.js';
import { InMemoryApiRepository } from './repositories/apiRepository.js';
import type { DeveloperRepository } from './repositories/developerRepository.js';
import { InMemoryUsageEventsRepository } from './repositories/usageEventsRepository.js';

const developerProfile: Developer = {
  id: 42,
  user_id: 'dev-1',
  name: 'Alice',
  website: null,
  description: null,
  category: null,
  created_at: new Date(0),
  updated_at: new Date(0),
};

const developerRepository: DeveloperRepository = {
  async findByUserId(userId: string) {
    return userId === developerProfile.user_id ? developerProfile : undefined;
  },
};

const validBody = {
  name: 'Weather API',
  description: 'Forecasts and current conditions',
  base_url: 'https://api.weather.example.com',
  category: 'weather',
  endpoints: [
    {
      path: '/forecast',
      method: 'GET',
      price_per_call_usdc: '0.01',
      description: 'Daily forecast',
    },
  ],
};

function buildApp() {
  return createApp({
    usageEventsRepository: new InMemoryUsageEventsRepository(),
    developerRepository,
    apiRepository: new InMemoryApiRepository(),
  });
}

describe('POST /api/apis', () => {
  test('returns validation details with field paths for invalid endpoint payloads', async () => {
    const response = await request(buildApp())
      .post('/api/apis')
      .set('x-user-id', 'dev-1')
      .send({
        ...validBody,
        endpoints: [{ path: '/forecast', method: 'FETCH', price_per_call_usdc: 'free' }],
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'VALIDATION_ERROR');
    assert.deepEqual(
      response.body.details.map((detail: { field: string }) => detail.field),
      ['body.endpoints[0].method', 'body.endpoints[0].price_per_call_usdc'],
    );
  });

  test('creates an authenticated developer API and exposes it through GET /api/apis', async () => {
    const app = buildApp();

    const createResponse = await request(app)
      .post('/api/apis')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    assert.equal(createResponse.status, 201);
    assert.equal(createResponse.body.developer_id, developerProfile.id);
    assert.equal(createResponse.body.status, 'active');
    assert.equal(createResponse.body.endpoints.length, 1);

    const listResponse = await request(app).get('/api/apis');
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.data.length, 1);
    assert.equal(listResponse.body.data[0].name, validBody.name);

    const detailResponse = await request(app).get(`/api/apis/${createResponse.body.id}`);
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.endpoints[0].price_per_call_usdc, '0.01');
  });
});
