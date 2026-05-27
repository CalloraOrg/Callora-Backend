jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { InMemoryApiRepository } from '../repositories/apiRepository.js';
import { createApisRouter } from './apis.js';

describe('createApisRouter', () => {
  function buildApp() {
    const repo = new InMemoryApiRepository(
      [
        {
          id: 1,
          name: 'Weather API',
          description: 'Provides weather data',
          base_url: 'https://api.weather.test',
          logo_url: null,
          category: 'weather',
          status: 'active',
          developer: {
            name: 'Acme Corp',
            website: 'https://acme.test',
            description: 'Leading data provider',
          },
        },
        {
          id: 2,
          name: 'Translate API',
          description: null,
          base_url: 'https://api.translate.test',
          logo_url: null,
          category: 'language',
          status: 'draft',
          developer: {
            name: 'Draft Dev',
            website: null,
            description: null,
          },
        },
      ],
      new Map([
        [
          1,
          [
            {
              path: '/current',
              method: 'GET',
              price_per_call_usdc: '0.01',
              description: 'Current weather',
            },
          ],
        ],
      ]),
    );

    const app = express();
    app.use('/api/apis', createApisRouter({ apiRepository: repo }));
    app.use(errorHandler);
    return app;
  }

  it('returns only active apis by default with pagination metadata', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, limit: 20, offset: 0 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: 1,
        name: 'Weather API',
        status: 'active',
        endpoints: [
          expect.objectContaining({
            path: '/current',
            method: 'GET',
            price_per_call_usdc: '0.01',
          }),
        ],
      }),
    );
  });

  it('supports valid status filtering', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis?status=draft');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, limit: 20, offset: 0 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(2);
    expect(res.body.data[0].status).toBe('draft');
  });

  it('rejects unknown status filters with 400', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis?status=invalid');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('status must be one of');
  });

  it('applies pagination params to the response metadata and items', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis?status=active&limit=1&offset=0');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, limit: 1, offset: 0 });
    expect(res.body.data).toHaveLength(1);
  });
});
