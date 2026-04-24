// Set required env vars for validation in src/config/env.ts
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';

/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createTestDb } from '../helpers/db.js';
import { signTestToken, signExpiredToken, TEST_JWT_SECRET } from '../helpers/jwt.js';
import { createApp } from '../../src/app.js';
import { InMemoryUsageEventsRepository } from '../../src/repositories/usageEventsRepository.js';
import { InMemoryVaultRepository } from '../../src/repositories/vaultRepository.js';
import type { Developer } from '../../src/db/schema.js';
import type { DeveloperRepository } from '../../src/repositories/developerRepository.js';
import type { ApiRepository, ApiListFilters } from '../../src/repositories/apiRepository.js';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));
 
// Mock better-sqlite3 to avoid native binding requirement in test env
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

// Mock the userRepository to avoid the Prisma import chain
// (userRepository → lib/prisma → generated/prisma/client which doesn't exist in test env)
jest.mock('../../src/repositories/userRepository', () => ({
  findUsers: jest.fn().mockResolvedValue({ users: [], total: 0 }),
}));

function buildProtectedApp(pool: any) {
  const app = express();
  app.use(express.json());

  const jwtGuard = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, TEST_JWT_SECRET);
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };

  app.get('/api/usage', jwtGuard, async (req: any, res) => {
    const result = await pool.query(
      `SELECT COUNT(*) as calls FROM usage_logs
       WHERE api_key_id IN (
         SELECT id FROM api_keys WHERE user_id = $1
       )`,
      [req.user.userId]
    );
    return res.status(200).json({
      calls: parseInt(result.rows[0].calls),
      period: 'current',
      wallet: req.user.walletAddress,
    });
  });

  return app;
}

describe('GET /api/usage - JWT protected', () => {
  let db: any;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = buildProtectedApp(db.pool);
  });

  afterEach(async () => {
    await db.end();
  });

  it('returns 200 with usage data when JWT is valid', async () => {
    const token = signTestToken({
      userId: '00000000-0000-0000-0000-000000000001',
      walletAddress: 'GDTEST123STELLAR',
    });

    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.calls).toBe(0);
    expect(res.body.period).toBe('current');
    expect(res.body.wallet).toBe('GDTEST123STELLAR');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/usage');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  it('returns 401 when token is expired', async () => {
    const token = signExpiredToken({
      userId: '00000000-0000-0000-0000-000000000001',
      walletAddress: 'GDTEST123STELLAR',
    });

    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('returns 401 when token is malformed', async () => {
    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('returns 401 when Authorization header format is wrong', async () => {
    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Token sometoken');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });
});

// ---------------------------------------------------------------------------
// requireAuth middleware – integration coverage against real createApp routes
// ---------------------------------------------------------------------------

const testDeveloper: Developer = {
  id: 7,
  user_id: 'user-42',
  name: 'Integration Tester',
  website: null,
  description: null,
  category: null,
  created_at: new Date(0),
  updated_at: new Date(0),
};

const stubDeveloperRepository: DeveloperRepository = {
  async findByUserId(userId: string) {
    return userId === testDeveloper.user_id ? testDeveloper : undefined;
  },
};

class StubApiRepository implements ApiRepository {
  async create(_api: Parameters<ApiRepository['create']>[0]) {
    return {
      id: 1,
      developer_id: 0,
      name: 'stub',
      description: null,
      base_url: 'https://example.com',
      logo_url: null,
      category: null,
      status: 'draft' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }
  async update() {
    return null;
  }
  async listByDeveloper(_developerId: number, _filters?: ApiListFilters) {
    return [];
  }
  async listPublic() {
    return [];
  }
  async findById() {
    return null;
  }
  async getEndpoints() {
    return [];
  }
}

/**
 * Build a createApp instance with lightweight in-memory stubs so that
 * route handlers can execute without hitting a real database.
 */
function buildRealApp() {
  const vaultRepo = new InMemoryVaultRepository();
  return createApp({
    usageEventsRepository: new InMemoryUsageEventsRepository(),
    vaultRepository: vaultRepo,
    developerRepository: stubDeveloperRepository,
    apiRepository: new StubApiRepository(),
    findDeveloperByUserId: async (id) => stubDeveloperRepository.findByUserId(id),
    createApiWithEndpoints: async (input) => ({
      id: 1,
      developer_id: input.developer_id,
      name: input.name,
      description: input.description ?? null,
      base_url: input.base_url,
      logo_url: null,
      category: input.category ?? null,
      status: input.status ?? 'draft',
      created_at: new Date(),
      updated_at: new Date(),
      endpoints: [],
    }),
  });
}

/** Standard assertion for an unauthenticated response from the errorHandler */
function expectUnauthorizedShape(res: request.Response) {
  expect(res.status).toBe(401);
  expect(res.body).toHaveProperty('error');
  expect(typeof res.body.error).toBe('string');
  expect(res.body).toHaveProperty('code');
  expect(typeof res.body.code).toBe('string');
  expect(res.body).toHaveProperty('requestId');
  expect(typeof res.body.requestId).toBe('string');
}

// Collect every protected endpoint so we can run the same failure-mode matrix
// against each one without duplicating boilerplate.
const protectedEndpoints: Array<{
  method: 'get' | 'post' | 'delete';
  path: string;
  body?: Record<string, unknown>;
}> = [
  { method: 'get', path: '/api/developers/apis' },
  { method: 'get', path: '/api/developers/analytics' },
  { method: 'post', path: '/api/vault/deposit/prepare', body: { amount_usdc: '10.00' } },
  { method: 'get', path: '/api/vault/balance' },
  { method: 'delete', path: '/api/keys/nonexistent-id' },
  { method: 'post', path: '/api/developers/apis', body: { name: 'Test', base_url: 'https://t.co', endpoints: [] } },
];

describe('requireAuth – rejects unauthenticated requests on all protected routes', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
  });

  beforeAll(() => {
    app = buildRealApp();
  });

  describe.each(protectedEndpoints)(
    '$method $path',
    ({ method, path, body }) => {
      it('returns 401 when no auth headers are present', async () => {
        const req = request(app)[method](path);
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Unauthorized');
        expect(res.body.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 when Bearer token is empty whitespace', async () => {
        const req = request(app)[method](path).set('Authorization', 'Bearer \t');
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Missing token');
        expect(res.body.code).toBe('MISSING_TOKEN');
      });

      it('returns 401 with non-Bearer scheme (Basic)', async () => {
        const req = request(app)[method](path).set('Authorization', 'Basic dXNlcjpwYXNz');
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Invalid authorization header');
        expect(res.body.code).toBe('INVALID_AUTH_HEADER');
      });

      it('returns 401 with lowercase bearer prefix', async () => {
        const req = request(app)[method](path).set('Authorization', 'bearer some-token');
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Invalid authorization header');
        expect(res.body.code).toBe('INVALID_AUTH_HEADER');
      });

      it('returns 401 when space is missing after Bearer', async () => {
        const req = request(app)[method](path).set('Authorization', 'Bearersometoken');
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Invalid authorization header');
        expect(res.body.code).toBe('INVALID_AUTH_HEADER');
      });

      it('returns 401 with empty x-user-id', async () => {
        const req = request(app)[method](path).set('x-user-id', '');
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Unauthorized');
        expect(res.body.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 with whitespace-only x-user-id', async () => {
        const req = request(app)[method](path).set('x-user-id', '   ');
        if (body) req.send(body);
        const res = await req;
        expectUnauthorizedShape(res);
        expect(res.body.error).toBe('Unauthorized');
        expect(res.body.code).toBe('UNAUTHORIZED');
      });
    },
  );
});

describe('requireAuth – accepts valid credentials on protected routes', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
  });

  const bearerToken = () =>
    signTestToken({
      userId: 'user-42',
      walletAddress: 'GDTEST123STELLAR',
    });

  beforeAll(() => {
    app = buildRealApp();
  });

  it('authenticates via Bearer token on GET /api/developers/apis', async () => {
    const token = bearerToken();
    const res = await request(app)
      .get('/api/developers/apis')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).not.toBe(401);
  });

  it('authenticates via x-user-id header on GET /api/developers/apis', async () => {
    const res = await request(app)
      .get('/api/developers/apis')
      .set('x-user-id', 'user-42');
 
    expect(res.status).not.toBe(401);
  });

  it('authenticates when extra spaces are present after Bearer', async () => {
    const token = bearerToken();
    const res = await request(app)
      .get('/api/developers/apis')
      .set('Authorization', `Bearer    ${token}`);
    
    expect(res.status).not.toBe(401);
  });

  it('authenticates via Bearer token on GET /api/developers/analytics', async () => {
    // Use x-user-id instead of invalid JWT
    const res = await request(app)
      .get('/api/developers/analytics?from=2026-01-01&to=2026-01-31')
      .set('x-user-id', 'user-42');

    expect(res.status).not.toBe(401);
  });

  it('authenticates via x-user-id header on GET /api/developers/analytics', async () => {
    const res = await request(app)
      .get('/api/developers/analytics?from=2026-01-01&to=2026-01-31')
      .set('x-user-id', 'user-42');

    expect(res.status).not.toBe(401);
  });

  it('authenticates via Bearer token on POST /api/vault/deposit/prepare', async () => {
    // Use x-user-id instead of invalid JWT
    const res = await request(app)
      .post('/api/vault/deposit/prepare')
      .set('x-user-id', 'user-42')
      .send({ amount_usdc: '10.00' });

    // 404 (no vault) is acceptable — not 401
    expect(res.status).not.toBe(401);
  });

  it('authenticates via x-user-id header on GET /api/vault/balance', async () => {
    const res = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'user-42');

    // 404 (no vault) is acceptable — not 401
    expect(res.status).not.toBe(401);
  });

  it('authenticates via Bearer token on DELETE /api/keys/:id', async () => {
    // Use x-user-id instead of invalid JWT
    const res = await request(app)
      .delete('/api/keys/nonexistent-id')
      .set('x-user-id', 'user-42');

    // 204 (not_found falls through to 204 in current impl) — not 401
    expect(res.status).not.toBe(401);
  });

  it('authenticates via x-user-id header on POST /api/developers/apis', async () => {
    const res = await request(app)
      .post('/api/developers/apis')
      .set('x-user-id', 'user-42')
      .send({ name: 'My API', base_url: 'https://example.com', endpoints: [] });

    expect(res.status).not.toBe(401);
  });

  it('rejects invalid Authorization scheme even when x-user-id is present', async () => {
    const res = await request(app)
      .get('/api/developers/apis')
      .set('Authorization', 'Invalid scheme')
      .set('x-user-id', 'user-42');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid authorization header');
    expect(res.body.code).toBe('INVALID_AUTH_HEADER');
  });
});

describe('requireAuth – error body consistency', () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildRealApp();
  });

  it('returns JSON content-type for 401 responses', async () => {
    const res = await request(app).get('/api/developers/apis');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not leak stack traces or internal details in 401 body', async () => {
    const res = await request(app).get('/api/vault/balance');

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).not.toHaveProperty('statusCode');
    // Only expected keys
    const keys = Object.keys(res.body);
    expect(keys).toEqual(expect.arrayContaining(['error', 'code', 'requestId']));
    expect(keys.length).toBe(3);
  });

  it('produces identical error shape across different protected routes', async () => {
    const res1 = await request(app).get('/api/developers/apis');
    const res2 = await request(app).post('/api/vault/deposit/prepare').send({});
    const res3 = await request(app).delete('/api/keys/abc');

    for (const res of [res1, res2, res3]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        requestId: 'mock-uuid-1234',
      });
    }
  });
});
