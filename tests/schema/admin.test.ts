/**
 * Response schema stability test for the `/api/admin` surface.
 *
 * Snapshot tests that assert admin response shapes do not drift accidentally.
 * Unlike the integration suites (which assert individual field values with
 * `toMatchObject` / `toEqual`), this suite locks the *full* JSON shape —
 * every top-level and nested key — so additive or renaming drift fails CI.
 *
 * Targets a focused subset of the admin router:
 *   - GET  /api/admin/users
 *   - GET  /api/admin/usage/:developerId
 *   - POST /api/admin/usage/:developerId/reset
 *
 * Closes #899
 */

process.env.JWT_SECRET = 'test-schema-admin-secret';
process.env.ADMIN_API_KEY = 'test-schema-admin-api-key';
process.env.METRICS_API_KEY = 'test-metrics-key';
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_IP_ALLOWED_RANGES;
delete process.env.ADMIN_IP_ALLOWLIST_ENABLED;

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { findUsers } from '../../src/repositories/userRepository.js';

jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000099' }));

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

jest.mock('../../src/logger', () => {
  const actual = jest.requireActual('../../src/logger');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      audit: jest.fn(),
      debug: jest.fn(),
    },
  };
});

// Main currently exports webhook-style helpers only; admin/audit still imports
// `securityHeaders`. Stub it so this schema suite can load the admin router.
jest.mock('../../src/middleware/securityHeaders.js', () => ({
  securityHeaders: (_req: unknown, _res: unknown, next: () => void) => next(),
  securityHeadersMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  createSecurityHeadersMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  AUDIT_CSP_POLICY: "default-src 'self'",
  AUDIT_X_CONTENT_TYPE_OPTIONS: 'nosniff',
  AUDIT_REFERRER_POLICY: 'strict-origin-when-cross-origin',
}));

jest.mock('../../src/repositories/userRepository', () => ({
  findUsers: jest.fn(),
}));

const mockFindUsers = findUsers as jest.MockedFunction<typeof findUsers>;

const TEST_ADMIN_API_KEY = 'test-schema-admin-api-key';
const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000001';

const USERS_SUCCESS_KEYS = ['data', 'meta'];
const USERS_META_KEYS = ['limit', 'offset', 'total'];
const USER_ITEM_KEYS = ['email', 'id', 'role'];
const USAGE_SNAPSHOT_KEYS = [
  'apiCount',
  'developerId',
  'endpointCount',
  'firstEventAt',
  'lastEventAt',
  'settledAmountUsdc',
  'settledEvents',
  'statusCodes',
  'totalAmountUsdc',
  'totalEvents',
  'unsettledAmountUsdc',
  'unsettledEvents',
].sort();

describe('/api/admin — response schema stability', () => {
  let app: express.Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let usageStore: any;

  beforeAll(() => {
    const usageStoreModule = jest.requireActual('../../src/services/usageStore.js') as {
      InMemoryUsageStore: new () => {
        record: (...args: unknown[]) => boolean;
        getDeveloperUsageSnapshot: (developerId: string) => unknown;
        resetDeveloperUsage: (developerId: string) => unknown;
        clear: () => void;
      };
    };

    usageStore = new usageStoreModule.InMemoryUsageStore();

    jest.doMock('../../src/services/usageStore.js', () => ({
      ...usageStoreModule,
      createUsageStore: jest.fn(() => usageStore),
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const adminRouter = require('../../src/routes/admin.js').default;

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    delete process.env.ADMIN_IP_ALLOWED_RANGES;
    delete process.env.ADMIN_IP_ALLOWLIST_ENABLED;

    mockFindUsers.mockResolvedValue({
      users: [
        { id: 'user-admin', email: 'admin@callora.test', role: 'admin' },
        { id: 'user-dev', email: 'dev@callora.test', role: 'developer' },
      ],
      total: 2,
    });

    usageStore?.clear();
    jest.clearAllMocks();
  });

  const seedUsage = () => {
    usageStore.record({
      id: 'evt_1',
      requestId: 'req_1',
      apiKey: 'secret-api-key',
      apiKeyId: 'key_1',
      apiId: 'api_1',
      endpointId: 'endpoint_1',
      userId: 'dev_001',
      amountUsdc: 1.5,
      statusCode: 200,
      timestamp: '2026-06-25T10:00:00.000Z',
    });
    usageStore.record({
      id: 'evt_2',
      requestId: 'req_2',
      apiKey: 'another-secret-api-key',
      apiKeyId: 'key_2',
      apiId: 'api_2',
      endpointId: 'endpoint_2',
      userId: 'dev_001',
      amountUsdc: 2,
      statusCode: 500,
      timestamp: '2026-06-25T10:05:00.000Z',
      settlementId: 'stl_1',
    });
  };

  describe('GET /api/admin/users', () => {
    it('matches the known success response shape', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('x-admin-api-key', TEST_ADMIN_API_KEY)
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
    });

    it('always returns the same top-level and nested key sets on success', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('x-admin-api-key', TEST_ADMIN_API_KEY);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([...USERS_SUCCESS_KEYS].sort());
      expect(Object.keys(res.body.meta).sort()).toEqual([...USERS_META_KEYS].sort());
      for (const user of res.body.data) {
        expect(Object.keys(user).sort()).toEqual([...USER_ITEM_KEYS].sort());
      }
    });

    it('matches the standardized error envelope when unauthenticated', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(401);
      expect(res.body).toMatchSnapshot({
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });

  describe('GET /api/admin/usage/:developerId', () => {
    it('matches the known success response shape', async () => {
      seedUsage();

      const res = await request(app)
        .get('/api/admin/usage/dev_001')
        .set('x-admin-api-key', TEST_ADMIN_API_KEY)
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
      expect(Object.keys(res.body).sort()).toEqual(['data']);
      expect(Object.keys(res.body.data).sort()).toEqual(USAGE_SNAPSHOT_KEYS);
    });

    it('matches the standardized not-found envelope', async () => {
      const res = await request(app)
        .get('/api/admin/usage/missing_dev')
        .set('x-admin-api-key', TEST_ADMIN_API_KEY)
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(404);
      expect(res.body).toMatchSnapshot({
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });

  describe('POST /api/admin/usage/:developerId/reset', () => {
    it('matches the known success response shape', async () => {
      seedUsage();

      const res = await request(app)
        .post('/api/admin/usage/dev_001/reset')
        .set('x-admin-api-key', TEST_ADMIN_API_KEY)
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
      expect(Object.keys(res.body).sort()).toEqual(['data']);
      expect(Object.keys(res.body.data).sort()).toEqual(
        ['developerId', 'priorValues', 'reset'].sort(),
      );
      expect(Object.keys(res.body.data.priorValues).sort()).toEqual(USAGE_SNAPSHOT_KEYS);
    });
  });
});
