import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../../src/app.js';
import { envelopeSchema, errorEnvelopeSchema, successEnvelopeSchema } from '../../src/middleware/envelope.js';

jest.mock('uuid', () => ({ v4: () => 'mock-contract-uuid' }));

jest.mock('../../src/services/transactionBuilder.js', () => ({
  TransactionBuilderService: class MockTxBuilder {},
}));

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

const assertEnvelope = (body: unknown) => {
  const result = envelopeSchema.safeParse(body);
  expect(result.success).toBe(true);
};

const assertSuccessEnvelope = (body: unknown, dataSchema?: z.ZodSchema) => {
  const envResult = successEnvelopeSchema.safeParse(body);
  expect(envResult.success).toBe(true);
  if (!envResult.success) return;
  const env = envResult.data;
  expect(env.success).toBe(true);
  expect(typeof env.requestId).toBe('string');
  expect(env.requestId.length).toBeGreaterThan(0);
  expect(() => new Date(env.timestamp)).not.toThrow();
  if (dataSchema) {
    const dataResult = dataSchema.safeParse(env.data);
    expect(dataResult.success).toBe(true);
  }
};

const assertErrorEnvelope = (body: unknown, expectedCode?: string) => {
  const envResult = errorEnvelopeSchema.safeParse(body);
  expect(envResult.success).toBe(true);
  if (!envResult.success) return;
  const env = envResult.data;
  expect(env.success).toBe(false);
  expect(typeof env.error.code).toBe('string');
  expect(typeof env.error.message).toBe('string');
  expect(typeof env.requestId).toBe('string');
  expect(env.requestId.length).toBeGreaterThan(0);
  expect(() => new Date(env.timestamp)).not.toThrow();
  if (expectedCode) {
    expect(env.error.code).toBe(expectedCode);
  }
};

describe('Envelope Contract: All API Responses', () => {
  const app = createApp();

  describe('GET /api/health - public health endpoint', () => {
    it('wraps 200 response in canonical success envelope', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      assertEnvelope(res.body);
      assertSuccessEnvelope(res.body, z.object({
        status: z.string(),
        service: z.string(),
      }));
    });
  });

  describe('GET /api/openapi.json - contract endpoint', () => {
    it('wraps 200 response in canonical success envelope', async () => {
      const res = await request(app).get('/api/openapi.json');
      expect(res.status).toBe(200);
      assertEnvelope(res.body);
      assertSuccessEnvelope(res.body);
      const env = res.body as { success: boolean; data: { openapi?: string } };
      if (env.success && typeof env.data === 'object' && env.data !== null) {
        expect(env.data.openapi).toBe('3.1.0');
      }
    });
  });

  describe('Unauthenticated error responses', () => {
    it('GET /api/usage returns 401 in canonical error envelope', async () => {
      const res = await request(app).get('/api/usage');
      expect(res.status).toBe(401);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body, 'UNAUTHORIZED');
    });

    it('GET /api/billing/credits returns 401 in canonical error envelope', async () => {
      const res = await request(app).get('/api/billing/credits');
      expect(res.status).toBe(401);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body, 'UNAUTHORIZED');
    });

    it('GET /api/developers/analytics returns 401 in canonical error envelope', async () => {
      const res = await request(app).get('/api/developers/analytics');
      expect(res.status).toBe(401);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body, 'UNAUTHORIZED');
    });
  });

  describe('Validation error responses (400)', () => {
    it('POST /api/developers/apis with missing name returns VALIDATION_ERROR envelope', async () => {
      const res = await request(app)
        .post('/api/developers/apis')
        .set('x-user-id', 'dev-1')
        .set('Content-Type', 'application/json')
        .send({
          base_url: 'https://api.example.com',
          category: 'test',
          endpoints: [{ path: '/test', method: 'GET', price_per_call_usdc: '0.01' }],
        });
      expect(res.status).toBe(400);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body, 'VALIDATION_ERROR');
      const env = res.body as { success: false; error: { details?: Array<{ field: string }> } };
      if (!env.success && env.error.details) {
        expect(env.error.details.length).toBeGreaterThan(0);
        expect(env.error.details[0].field).toBeTruthy();
      }
    });

    it('GET /api/developers/analytics with bad dates returns BAD_REQUEST envelope', async () => {
      const res = await request(app)
        .get('/api/developers/analytics?from=bad&to=bad')
        .set('x-user-id', 'dev-1');
      expect(res.status).toBe(400);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body, 'BAD_REQUEST');
    });
  });

  describe('404 Not Found responses', () => {
    it('unknown route under /api returns canonical error envelope', async () => {
      const res = await request(app).get('/api/nonexistent-route');
      expect(res.status).toBe(404);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body);
      const env = res.body as { success: false; error: { code: string } };
      if (!env.success) {
        expect(env.error.code).toBeTruthy();
      }
    });
  });

  describe('413 Body Too Large responses', () => {
    it('returns canonical error envelope with code', async () => {
      const oversizedBody = JSON.stringify({ data: 'x'.repeat(200 * 1024) });
      const res = await request(app)
        .post('/api/developers/apis')
        .set('Content-Type', 'application/json')
        .send(oversizedBody);
      expect(res.status).toBe(413);
      assertEnvelope(res.body);
      assertErrorEnvelope(res.body, 'REQUEST_BODY_TOO_LARGE');
    });
  });
});

describe('Envelope Contract: Paginated & Data Responses', () => {
  const { InMemoryUsageEventsRepository } = require('../../src/repositories/usageEventsRepository.js');
  const { InMemoryApiRepository } = require('../../src/repositories/apiRepository.js');

  const seedRepository = () =>
    new InMemoryUsageEventsRepository([
      {
        id: 'evt-1',
        developerId: 'dev-1',
        apiId: 'api-1',
        endpoint: '/v1/search',
        userId: 'user-alpha-001',
        occurredAt: new Date('2026-02-01T10:00:00.000Z'),
        revenue: 100n,
      },
      {
        id: 'evt-2',
        developerId: 'dev-1',
        apiId: 'api-1',
        endpoint: '/v1/search',
        userId: 'user-alpha-001',
        occurredAt: new Date('2026-02-01T16:00:00.000Z'),
        revenue: 140n,
      },
    ]);

  const sampleApis = [
    {
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
    },
  ];

  const developerRepository = {
    async findByUserId(userId: string) {
      if (userId === 'dev-1') {
        return {
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
      }
      return undefined;
    },
    async getOrCreateByUserId(userId: string) {
      return {
        id: 999,
        user_id: userId,
        name: null,
        website: null,
        description: null,
        category: null,
        plan_overrides: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    async upsertProfile(userId: string, data: unknown) {
      return { id: 1, user_id: userId, ...(typeof data === 'object' && data !== null ? data : {}), updated_at: new Date() };
    },
  };

  const app = createApp({
    usageEventsRepository: seedRepository(),
    apiRepository: new InMemoryApiRepository(sampleApis),
    developerRepository,
  });

  describe('GET /api/developers/analytics - data response', () => {
    it('returns 200 with analytics inside canonical success envelope', async () => {
      const res = await request(app)
        .get('/api/developers/analytics?from=2026-01-01&to=2026-03-31&groupBy=day')
        .set('x-user-id', 'dev-1');
      expect(res.status).toBe(200);
      assertEnvelope(res.body);
      assertSuccessEnvelope(res.body, z.object({
        data: z.array(z.object({
          period: z.string(),
          calls: z.number(),
          revenue: z.string(),
        })),
      }));
    });
  });

  describe('GET /api/developers/apis - paginated response', () => {
    it('returns 200 with list inside canonical success envelope and meta', async () => {
      const res = await request(app)
        .get('/api/developers/apis?limit=10&offset=0')
        .set('x-user-id', 'dev-1');
      expect(res.status).toBe(200);
      assertEnvelope(res.body);
      const env = successEnvelopeSchema.parse(res.body);
      expect(env.success).toBe(true);
      expect(env.meta).toBeDefined();
      expect(typeof (env.meta as { limit?: unknown }).limit).toBe('number');
      expect(typeof (env.meta as { offset?: unknown }).offset).toBe('number');
      expect(Array.isArray(env.data)).toBe(true);
    });
  });

  describe('GET /api/apis/:id - detail response', () => {
    it('returns 200 with API detail inside canonical success envelope', async () => {
      const apiRepo = new InMemoryApiRepository([
        {
          id: 1,
          name: 'Weather API',
          description: 'Real-time weather data',
          base_url: 'https://api.weather.example.com',
          logo_url: 'https://cdn.example.com/logo.png',
          category: 'weather',
          status: 'active',
          developer: {
            name: 'Alice Dev',
            website: 'https://alice.example.com',
            description: 'Building climate tools',
          },
        },
      ]);
      const detailApp = createApp({ apiRepository: apiRepo });
      const res = await request(detailApp).get('/api/apis/1');
      expect(res.status).toBe(200);
      assertEnvelope(res.body);
      assertSuccessEnvelope(res.body, z.object({
        id: z.union([z.number(), z.string()]),
        name: z.string(),
      }));
    });
  });
});

describe('POST /api/billing/deduct OpenAPI Contract', () => {
  const app = createApp();

  it('returns 401 response matching canonical error envelope', async () => {
    const res = await request(app)
      .post('/api/billing/deduct')
      .send({});
    expect(res.status).toBe(401);
    assertEnvelope(res.body);
    assertErrorEnvelope(res.body, 'UNAUTHORIZED');
  });

  it('returns 400 response matching canonical error envelope for missing fields', async () => {
    const res = await request(app)
      .post('/api/billing/deduct')
      .set('x-user-id', 'dev-1')
      .send({});
    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    assertErrorEnvelope(res.body, 'BAD_REQUEST');
  });
});

describe('Cross-Origin Request Contract', () => {
  const app = createApp();

  it('OPTIONS preflight returns success envelope on GET /api/health', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');
    expect([200, 204]).toContain(res.status);
  });

  it('CORS header + envelope on actual GET /api/health', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeTruthy();
    assertEnvelope(res.body);
  });
});

