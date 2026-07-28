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
import type { Api, Developer } from '../db/schema.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { AuditService } from '../services/auditService.js';
import { createApisRouter } from './apis.js';

const developerProfile: Developer = {
  id: 11,
  user_id: 'dev-1',
  name: 'Test Developer',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: new Date(1000),
  updated_at: new Date(1000),
};

const developerRepository: DeveloperRepository = {
  async findByUserId(userId: string) {
    return userId === 'dev-1' ? developerProfile : undefined;
  },
  async getOrCreateByUserId() { return developerProfile; },
  async upsertProfile() { return developerProfile; },
};

function buildApp(auditService: AuditService, repo = new InMemoryApiRepository([], new Map())) {
  const app = express();
  app.use(express.json());
  app.use('/api/apis', createApisRouter({ apiRepository: repo, developerRepository, auditService }));
  app.use(errorHandler);
  return app;
}

const createBody = {
  name: 'Audit API',
  base_url: 'https://audit.example.com',
  category: 'search',
  endpoints: [{ path: '/x', method: 'GET', price_per_call_usdc: '0.01' }],
};

describe('/api/apis audit logging (issue #777)', () => {
  it('records an API_CREATE audit row on successful creation', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const app = buildApp({ record });

    const res = await request(app).post('/api/apis').set('x-user-id', 'dev-1').send(createBody);

    expect(res.status).toBe(201);
    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry).toEqual(expect.objectContaining({ event: 'API_CREATE', actor: 'dev-1' }));
    expect(entry.details).toEqual(
      expect.objectContaining({
        before: null,
        after: expect.objectContaining({ name: 'Audit API', category: 'search', endpointCount: 1 }),
      }),
    );
  });

  it('records an API_ENDPOINTS_BULK_CREATE audit row on bulk endpoint creation', async () => {
    const ownedApi: Api = {
      id: 101,
      developer_id: 11,
      name: 'Search API',
      description: null,
      base_url: 'https://search.example.com',
      logo_url: null,
      category: 'search',
      status: 'active',
      created_at: new Date(1000),
      updated_at: new Date(1000),
      deleted_at: null,
    };
    const repo = new InMemoryApiRepository([ownedApi], new Map([[101, []]]));
    const record = jest.fn().mockResolvedValue(undefined);
    const app = buildApp({ record }, repo);

    const res = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: [{ path: '/new', method: 'POST', price_per_call_usdc: '0.02' }] });

    expect(res.status).toBe(201);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'API_ENDPOINTS_BULK_CREATE', actor: 'dev-1' }),
    );
  });

  it('does not fail the request when audit persistence throws', async () => {
    const record = jest.fn().mockRejectedValue(new Error('db down'));
    const app = buildApp({ record });

    const res = await request(app).post('/api/apis').set('x-user-id', 'dev-1').send(createBody);

    expect(res.status).toBe(201);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not write an audit row when creation is rejected (unauthenticated)', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const app = buildApp({ record });

    const res = await request(app).post('/api/apis').send(createBody);

    expect(res.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });
});
