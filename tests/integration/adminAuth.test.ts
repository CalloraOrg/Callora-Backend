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

const TEST_ADMIN_API_KEY = 'test-admin-api-key';
const TEST_JWT_SECRET = 'test-admin-jwt-secret';

const originalAdminApiKey = process.env.ADMIN_API_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

describe('adminAuth middleware on /api/admin routes', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mockFindUsers.mockResolvedValue({ users: [], total: 0 });
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

  it('rejects requests without admin credentials', async () => {
    const app = createApp();

    const res = await request(app).get('/api/admin/users');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: admin access required');
  });

  it('rejects requests with a non-matching admin API key', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', 'wrong-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: admin access required');
  });

  it('rejects JWT callers that are not admins', async () => {
    const app = createApp();
    const token = jwt.sign({ role: 'developer', sub: 'user-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: admin access required');
  });

  it('rejects expired JWT tokens', async () => {
    const app = createApp();
    const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, TEST_JWT_SECRET, { expiresIn: '-1s' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: admin access required');
  });

  it('rejects JWT tokens signed with the wrong secret', async () => {
    const app = createApp();
    const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, 'wrong-secret', { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: admin access required');
  });

  it('rejects a malformed Bearer token (not a valid JWT)', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer not-a-real-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: admin access required');
  });

  it('accepts valid admin API key credentials and logs audit event', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USERS',
      'admin-api-key',
      expect.objectContaining({ count: 0, total: 0 })
    );
  });

  it('accepts valid Bearer JWT credentials with admin role and logs audit event', async () => {
    const app = createApp();
    const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
    expect(logger.audit).toHaveBeenCalledWith(
      'LIST_USERS',
      'admin-1',
      expect.objectContaining({ count: 0, total: 0 })
    );
  });

  it('returns 500 for JWT auth path when JWT_SECRET is not configured', async () => {
    const app = createApp();
    delete process.env.JWT_SECRET;
    const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, 'unused-secret', { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('JWT_SECRET not configured');
  });

  it('prefers valid API key path even when Bearer token is invalid', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY)
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(200);
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
  });
});
