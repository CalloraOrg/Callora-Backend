import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { findUsers } from '../../src/repositories/userRepository.js';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));

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

  it('accepts valid admin API key credentials', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/admin/users')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
  });

  it('accepts valid Bearer JWT credentials with admin role', async () => {
    const app = createApp();
    const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(mockFindUsers).toHaveBeenCalledTimes(1);
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

