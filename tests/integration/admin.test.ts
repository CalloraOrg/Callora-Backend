/**
 * Integration tests for /api/admin
 *
 * Supertest-based end-to-end tests that hit the full /api/admin router,
 * covering authentication, user listing, quota request management, and
 * usage inspection/reset flows.
 *
 * Closes #783
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { findUsers } from '../../src/repositories/userRepository.js';
import { logger } from '../../src/logger.js';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));
jest.mock('../../src/logger', () => {
  const actual = jest.requireActual('../../src/logger');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      audit: jest.fn(),
    },
  };
});

// Avoid native binding requirements in test env.
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

// Bypass startup env-var validation so the test can control process.env at runtime.
jest.mock('../../src/config/env', () => ({
  env: {
    PORT: 3000,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/callora_test',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'callora_test',
    DB_POOL_MAX: 1,
    DB_IDLE_TIMEOUT_MS: 1000,
    DB_CONN_TIMEOUT_MS: 1000,
    JWT_SECRET: 'placeholder-replaced-by-beforeEach',
    ADMIN_API_KEY: 'placeholder-replaced-by-beforeEach',
    METRICS_API_KEY: 'test-metrics-api-key',
    UPSTREAM_URL: 'http://localhost:4000',
    PROXY_TIMEOUT_MS: 30000,
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    SOROBAN_RPC_ENABLED: false,
    HORIZON_ENABLED: false,
    STELLAR_TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    SOROBAN_TESTNET_RPC_URL: 'https://soroban-testnet.stellar.org',
    SOROBAN_MAINNET_RPC_URL: 'https://soroban-mainnet.stellar.org',
    STELLAR_BASE_FEE: 100,
    HEALTH_CHECK_DB_TIMEOUT: 2000,
    APP_VERSION: '1.0.0',
    LOG_LEVEL: 'info',
    GATEWAY_PROFILING_ENABLED: false,
  },
}));

// Mock userRepository to keep admin route tests isolated from Prisma wiring.
jest.mock('../../src/repositories/userRepository', () => ({
  findUsers: jest.fn(),
}));

const mockFindUsers = findUsers as jest.MockedFunction<typeof findUsers>;

const TEST_ADMIN_API_KEY = 'test-admin-api-key-integration';
const TEST_JWT_SECRET = 'test-admin-jwt-secret-integration';

const originalAdminApiKey = process.env.ADMIN_API_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

describe('GET /api/admin/users — Integration', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mockFindUsers.mockResolvedValue({
      users: [
        { id: 'user-1', email: 'admin@callora.com', role: 'admin' },
        { id: 'user-2', email: 'dev@callora.com', role: 'developer' },
      ],
      total: 2,
    });
  });

  afterEach(() => {
    if (originalAdminApiKey !== undefined) {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }

    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }

    jest.clearAllMocks();
  });

  it('returns paginated user list with valid admin API key', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(2);
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USERS',
      'admin-api-key',
      expect.objectContaining({
        clientIp: expect.any(String),
        count: 2,
        total: 2,
      }),
    );
  });

  it('returns paginated user list with valid admin JWT', async () => {
    const app = createApp();
    const token = jwt.sign(
      { role: 'admin', sub: 'admin-1' },
      TEST_JWT_SECRET,
      { expiresIn: '1h' },
    );

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USERS',
      'admin-1',
      expect.objectContaining({ count: 2, total: 2 }),
    );
  });

  it('rejects requests without admin credentials', async () => {
    const app = createApp();

    const res = await request(app).get('/api/admin/users');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe('Unauthorized: admin access required');
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with wrong admin API key', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', 'wrong-key');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-admin JWT callers', async () => {
    const app = createApp();
    const token = jwt.sign(
      { role: 'developer', sub: 'dev-1' },
      TEST_JWT_SECRET,
      { expiresIn: '1h' },
    );

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects expired JWT tokens', async () => {
    const app = createApp();
    const token = jwt.sign(
      { role: 'admin', sub: 'admin-1' },
      TEST_JWT_SECRET,
      { expiresIn: '-1s' },
    );

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('rejects JWT signed with wrong secret', async () => {
    const app = createApp();
    const token = jwt.sign(
      { role: 'admin', sub: 'admin-1' },
      'wrong-secret',
      { expiresIn: '1h' },
    );

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('returns 500 when JWT_SECRET is not set for JWT auth', async () => {
    const app = createApp();
    delete process.env.JWT_SECRET;
    const token = jwt.sign(
      { role: 'admin', sub: 'admin-1' },
      'unused-secret',
      { expiresIn: '1h' },
    );

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('prefers valid API key even when Bearer token is invalid', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY)
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(200);
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/admin/usage/:developerId — Integration', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalAdminApiKey !== undefined) {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }

    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }

    jest.clearAllMocks();
  });

  it('returns 401 when no admin credentials are provided', async () => {
    const app = createApp();

    const res = await request(app).get('/api/admin/usage/dev_test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for a developer with no usage aggregate', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/usage/nonexistent_dev')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('USAGE_AGGREGATE_NOT_FOUND');
  });
});

describe('POST /api/admin/usage/:developerId/reset — Integration', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalAdminApiKey !== undefined) {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }

    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }

    jest.clearAllMocks();
  });

  it('returns 401 when no admin credentials are provided', async () => {
    const app = createApp();

    const res = await request(app).post('/api/admin/usage/dev_test/reset');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for a developer with no usage aggregate to reset', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/admin/usage/nonexistent_dev/reset')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('USAGE_AGGREGATE_NOT_FOUND');
  });
});

describe('GET /api/admin/quota/requests — Integration', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalAdminApiKey !== undefined) {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }

    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }

    jest.clearAllMocks();
  });

  it('returns 401 when no admin credentials are provided', async () => {
    const app = createApp();

    const res = await request(app).get('/api/admin/quota/requests');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns list of quota requests with valid admin API key', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/quota/requests')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_QUOTA_REQUESTS',
      'admin-api-key',
      expect.objectContaining({
        clientIp: expect.any(String),
        count: expect.any(Number),
      }),
    );
  });

  it('filters quota requests by status', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/quota/requests?status=pending')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_QUOTA_REQUESTS',
      'admin-api-key',
      expect.objectContaining({
        filter: { status: 'pending' },
      }),
    );
  });

  it('returns 400 for invalid status filter', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/quota/requests?status=invalid')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(400);
  });
});

describe('Error response schema stability across admin routes', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalAdminApiKey !== undefined) {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }

    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }

    jest.clearAllMocks();
  });

  const adminRoutes = [
    { method: 'get' as const, path: '/api/admin/users' },
    { method: 'get' as const, path: '/api/admin/usage/some-dev' },
    { method: 'post' as const, path: '/api/admin/usage/some-dev/reset' },
    { method: 'get' as const, path: '/api/admin/quota/requests' },
  ];

  for (const route of adminRoutes) {
    it(`returns standardized 401 error for ${route.method.toUpperCase()} ${route.path} without credentials`, async () => {
      const app = createApp();

      const res = await request(app)[route.method](route.path);

      expect(res.status).toBe(401);
      // Standardized error envelope
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(typeof res.body.error.code).toBe('string');
      expect(typeof res.body.error.message).toBe('string');
    });
  }
});
