import assert from 'node:assert/strict';
import request from 'supertest';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));

jest.mock('../../src/services/transactionBuilder.js', () => ({
  TransactionBuilderService: class MockTxBuilder {},
}));

jest.mock('express-openapi-validator', () => ({
  middleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../src/routes/index.js', () => {
  const express = require('express');
  const { createApisRouter } = require('../../src/routes/apis.js');

  return {
    createApiRouter: ({ apiRepository, developerRepository }: { apiRepository?: unknown; developerRepository?: unknown }) => {
      const router = express.Router();
      router.use('/apis', createApisRouter({ apiRepository, developerRepository }));
      return router;
    },
  };
});

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';

import { createApp } from '../../src/app.js';
import { InMemoryApiRepository } from '../../src/repositories/apiRepository.js';
import { InMemoryUsageEventsRepository } from '../../src/repositories/usageEventsRepository.js';
import type { Developer } from '../../src/db/schema.js';
import type { DeveloperRepository } from '../../src/repositories/developerRepository.js';

describe('GET/POST /api/apis integration', () => {
  const developerProfile: Developer = {
    id: 42,
    user_id: 'dev-1',
    name: 'Alice',
    website: null,
    description: null,
    category: null,
    plan_overrides: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };

  const developerRepository: DeveloperRepository = {
    async findByUserId(userId: string) {
      return userId === developerProfile.user_id ? developerProfile : undefined;
    },
    async getOrCreateByUserId() {
      return developerProfile;
    },
    async upsertProfile() {
      return developerProfile;
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

  test('creates an API via POST /api/apis and exposes it through the public list and detail routes', async () => {
    const app = buildApp();

    const createResponse = await request(app)
      .post('/api/apis')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    assert.equal(createResponse.status, 201);
    assert.equal(createResponse.body.status, 'active');
    assert.equal(createResponse.body.endpoints.length, 1);

    const listResponse = await request(app).get('/api/apis');
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.data.length, 1);
    assert.equal(listResponse.body.data[0].name, validBody.name);

    const detailResponse = await request(app).get(`/api/apis/${createResponse.body.id}`);
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.body.name, validBody.name);
    assert.equal(detailResponse.body.endpoints[0].price_per_call_usdc, '0.01');
  });

  test('returns validation details for invalid endpoint payloads on POST /api/apis', async () => {
    const app = buildApp();

    const response = await request(app)
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
});
