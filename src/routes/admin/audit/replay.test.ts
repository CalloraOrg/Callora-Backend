/**
 * Tests for POST /api/admin/audit/replay
 *
 * Coverage:
 *   - Successful replay for each replayable action type
 *   - Authorization (admin API key + JWT)
 *   - Audit entry not found (404)
 *   - Non-replayable action type (AUDIT_ACTION_NOT_REPLAYABLE)
 *   - Invalid entryId input
 *   - Already resolved quota replay → already_resolved outcome
 *   - Missing target → not_found outcome
 *   - Incomplete audit entry details
 *   - Standardized error envelope
 *   - Admin audit logging on replay attempts
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

jest.mock('../../config/env', () => ({
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
    JWT_SECRET: 'test-jwt-secret',
    ADMIN_API_KEY: 'test-admin-api-key',
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

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../../middleware/errorHandler.js';
import {
  createAdminAuditReplayRouter,
  type AdminAuditReplayRouterDeps,
} from './replay.js';
import type {
  AuditLogEntry,
  AuditLogRepository,
} from '../../../repositories/auditLogRepository.js';
import type { CreditsRepository } from '../../../repositories/creditsRepository.js';
import type { ApiRepository, Api } from '../../../repositories/apiRepository.js';
import type {
  UsageAdminStore,
  UsageAggregateSnapshot,
} from '../../../services/usageStore.js';
import {
  getQuotaRequestStore,
  setQuotaRequestStore,
  type QuotaRequest,
  type QuotaRequestStore,
} from '../../../services/quotaService.js';

jest.mock('../../../logger', () => {
  const actual = jest.requireActual('../../../logger');
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

import { logger } from '../../../logger.js';

const ADMIN_KEY = 'test-replay-admin-key';
const JWT_SECRET = 'test-replay-jwt-secret';

// ---------------------------------------------------------------------------
// Mock repositories
// ---------------------------------------------------------------------------

class InMemoryAuditRepo implements AuditLogRepository {
  constructor(private readonly entries: Map<string, AuditLogEntry> = new Map()) {}

  setEntry(entry: AuditLogEntry): this {
    this.entries.set(entry.id, entry);
    return this;
  }

  findCursor(): Promise<{ entries: AuditLogEntry[]; hasMore: boolean }> {
    return Promise.resolve({ entries: [], hasMore: false });
  }

  findById(id: string): Promise<AuditLogEntry | undefined> {
    return Promise.resolve(this.entries.get(id));
  }
}

class MockCreditsRepo implements CreditsRepository {
  grantCalls: Array<{ userId: string; amountUsdc: string }> = [];

  findByUserId(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  getOrCreateByUserId(userId: string) {
    return Promise.resolve({
      id: 1,
      user_id: userId,
      balance_usdc: '0.00',
      created_at: new Date(0),
      updated_at: new Date(0),
    });
  }
  updateBalance(userId: string, newBalance: string) {
    return Promise.resolve({
      id: 1,
      user_id: userId,
      balance_usdc: newBalance,
      created_at: new Date(0),
      updated_at: new Date(0),
    });
  }
  grant(userId: string, amountUsdc: string) {
    this.grantCalls.push({ userId, amountUsdc });
    return Promise.resolve({
      id: 1,
      user_id: userId,
      balance_usdc: amountUsdc,
      created_at: new Date(0),
      updated_at: new Date(),
    });
  }
}

class MockApiRepo implements ApiRepository {
  deleteResults = new Map<number, boolean>();
  restoreResults = new Map<number, Api | null>();

  create() { throw new Error('not implemented'); }
  createWithEndpoints() { throw new Error('not implemented'); }
  update() { throw new Error('not implemented'); }
  findById() { throw new Error('not implemented'); }
  listByDeveloper() { throw new Error('not implemented'); }
  listAll() { throw new Error('not implemented'); }
  listActive() { throw new Error('not implemented'); }

  delete(id: number): Promise<boolean> {
    return Promise.resolve(this.deleteResults.get(id) ?? true);
  }
  restore(id: number): Promise<Api | null> {
    return Promise.resolve(
      this.restoreResults.has(id)
        ? this.restoreResults.get(id)!
        : ({ id, name: 'x', description: null, base_url: '', category: '', status: 'active', developer_id: 1, logo_url: null, created_at: new Date(0), updated_at: new Date(0), deleted_at: null } as unknown as Api),
    );
  }
}

class MockUsageStore implements UsageAdminStore {
  resetResults = new Map<string, UsageAggregateSnapshot | undefined>();
  record(): boolean { return true; }
  hasEvent(): boolean { return false; }
  getEvents() { return []; }
  getUnsettledEvents() { return []; }
  markAsSettled() { return; }
  getDeveloperUsageSnapshot() { return undefined; }

  resetDeveloperUsage(developerId: string): UsageAggregateSnapshot | undefined {
    return this.resetResults.get(developerId);
  }
}

// ---------------------------------------------------------------------------
// Quota store helpers
// ---------------------------------------------------------------------------

function makeQuotaStore(pendingRequests: QuotaRequest[] = []): QuotaRequestStore {
  return {
    create: () => Promise.reject(),
    async findById(id): Promise<QuotaRequest | undefined> {
      return pendingRequests.find((r) => r.id === id);
    },
    async list(): Promise<QuotaRequest[]> {
      return pendingRequests;
    },
    async update(id, changes): Promise<QuotaRequest | undefined> {
      const r = pendingRequests.find((x) => x.id === id);
      if (!r) return undefined;
      return Object.assign(r, changes);
    },
  };
}

// ---------------------------------------------------------------------------
// Base entry helper
// ---------------------------------------------------------------------------

const baseEntry = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'audit-base',
  event: 'RESET_USAGE_AGGREGATE',
  actor: 'admin-api-key',
  tenantId: null,
  clientIp: '127.0.0.1',
  userAgent: 'jest',
  correlationId: 'req-1',
  bodyHash: null,
  details: null,
  createdAt: '2026-06-28T10:00:00.000Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp(deps: AdminAuditReplayRouterDeps = {}) {
  const app = express();
  app.use(express.json());

  // Simulate adminAuth middleware paths
  app.use((req, res, next) => {
    const apiKey = req.headers['x-admin-api-key'];
    if (apiKey === ADMIN_KEY) {
      res.locals.adminActor = 'admin-api-key';
      return next();
    }

    const auth = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { role?: string };
        if (payload.role === 'admin') {
          res.locals.adminActor = 'admin-jwt';
          return next();
        }
      } catch {
        // fall through
      }
    }

    res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'Unauthorized: admin access required',
      requestId: 'test',
    });
  });

  app.use('/api/admin/audit/replay', createAdminAuditReplayRouter(deps));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Authorization tests
// ---------------------------------------------------------------------------

describe('POST /api/admin/audit/replay — authorization', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    jest.restoreAllMocks();
  });

  it('returns 200 with a valid admin API key', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({ id: 'auth-1', details: { developerId: 'dev-1' } }));

    const usageStore = new MockUsageStore();
    usageStore.resetResults.set('dev-1', {
      developerId: 'dev-1',
      totalEvents: 1,
      settledEvents: 0,
      unsettledEvents: 1,
      totalAmountUsdc: 0,
      settledAmountUsdc: 0,
      unsettledAmountUsdc: 0,
      apiCount: 0,
      endpointCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      statusCodes: {},
    });

    const app = buildApp({ auditLogRepository: auditRepo, usageStore });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'auth-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
  });

  it('returns 200 with a valid admin JWT', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({ id: 'auth-2', details: { developerId: 'dev-2' } }));

    const usageStore = new MockUsageStore();
    usageStore.resetResults.set('dev-2', undefined);

    const app = buildApp({ auditLogRepository: auditRepo, usageStore });
    const token = jwt.sign({ role: 'admin', sub: 'admin-user' }, JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'auth-2' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('returns 401 with no credentials', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'any' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with a wrong API key', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'any' })
      .set('x-admin-api-key', 'definitely-wrong');

    expect(res.status).toBe(401);
  });

  it('returns 401 with a non-admin JWT role', async () => {
    const app = buildApp();
    const token = jwt.sign({ role: 'developer', sub: 'user-1' }, JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'any' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('POST /api/admin/audit/replay — input validation', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    jest.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    jest.restoreAllMocks();
  });

  it('returns 400 when request body is missing', async () => {
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .set('x-admin-api-key', ADMIN_KEY);

    // express.json() sets body to undefined or {} depending on content-type;
    // either way the handler throws INVALID_BODY or INVALID_ENTRY_ID.
    expect(res.status).toBe(400);
    expect(res.body.code).toBeDefined();
  });

  it('returns 400 when entryId is missing', async () => {
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({})
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTRY_ID');
    expect(res.body.message).toContain('entryId');
  });

  it('returns 400 when entryId is not a string', async () => {
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 12345 })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTRY_ID');
  });

  it('returns 400 when entryId is empty', async () => {
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: '' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
  });

  it('returns 400 when entryId is only whitespace', async () => {
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: '   ' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Audit entry not found
// ---------------------------------------------------------------------------

describe('POST /api/admin/audit/replay — entry not found', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    jest.clearAllMocks();
    app = buildApp({ auditLogRepository: new InMemoryAuditRepo() });
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    jest.restoreAllMocks();
  });

  it('returns 404 when no audit entry exists for entryId', async () => {
    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'nonexistent-entry' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUDIT_ENTRY_NOT_FOUND');
    expect(res.body.message).toContain('nonexistent-entry');
  });

  it('records a failed replay attempt in the admin audit log', async () => {
    await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'missing-entry' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(logger.audit).toHaveBeenCalledWith(
      'AUDIT_REPLAYED',
      'admin-api-key',
      expect.objectContaining({
        originalEntryId: 'missing-entry',
        outcome: 'error',
        errorCode: 'AUDIT_ENTRY_NOT_FOUND',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Non-replayable action type
// ---------------------------------------------------------------------------

describe('POST /api/admin/audit/replay — non-replayable action', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    jest.restoreAllMocks();
  });

  it.each([
    ['LIST_USERS', null],
    ['LIST_AUDIT_LOGS', { count: 5 }],
    ['READ_USAGE_AGGREGATE', { developerId: 'dev-1' }],
    ['LIST_QUOTA_REQUESTS', { count: 2 }],
    ['AUDIT_REPLAYED', { originalEntryId: 'x' }],
    ['WEBHOOK_REPLAYED', { deliveryId: 'dlq-1' }],
  ])('returns 400 AUDIT_ACTION_NOT_REPLAYABLE for event=%s', async (event, details) => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({ id: `nr-${event}`, event, details }));
    app = buildApp({ auditLogRepository: auditRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: `nr-${event}` })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUDIT_ACTION_NOT_REPLAYABLE');
    expect(res.body.message).toContain(event);
  });

  it('records the not_replayable outcome in the admin audit log', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({ id: 'nr-log', event: 'LIST_USERS', details: { count: 1 } }));
    app = buildApp({ auditLogRepository: auditRepo });

    await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'nr-log' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(logger.audit).toHaveBeenCalledWith(
      'AUDIT_REPLAYED',
      'admin-api-key',
      expect.objectContaining({
        originalEntryId: 'nr-log',
        originalEvent: 'LIST_USERS',
        outcome: 'not_replayable',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Successful replays
// ---------------------------------------------------------------------------

describe('POST /api/admin/audit/replay — successful replay', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    setQuotaRequestStore(undefined as unknown as QuotaRequestStore);
    jest.restoreAllMocks();
  });

  it('replays RESET_USAGE_AGGREGATE with success outcome', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'reset-1',
      event: 'RESET_USAGE_AGGREGATE',
      details: { developerId: 'dev-reset-ok' },
    }));
    const usageStore = new MockUsageStore();
    const prior: UsageAggregateSnapshot = {
      developerId: 'dev-reset-ok',
      totalEvents: 10,
      settledEvents: 0,
      unsettledEvents: 10,
      totalAmountUsdc: 50,
      settledAmountUsdc: 0,
      unsettledAmountUsdc: 50,
      apiCount: 2,
      endpointCount: 5,
      firstEventAt: '2026-01-01T00:00:00.000Z',
      lastEventAt: '2026-06-01T00:00:00.000Z',
      statusCodes: { '200': 10 },
    };
    usageStore.resetResults.set('dev-reset-ok', prior);

    const app = buildApp({ auditLogRepository: auditRepo, usageStore });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'reset-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.entryId).toBe('reset-1');
    expect(res.body.data.originalEvent).toBe('RESET_USAGE_AGGREGATE');
    expect(res.body.data.outcome).toBe('success');
    expect(res.body.data.replayedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('replays RESET_USAGE_AGGREGATE with not_found outcome when snapshot missing', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'reset-nf',
      event: 'RESET_USAGE_AGGREGATE',
      details: { developerId: 'dev-missing' },
    }));
    const usageStore = new MockUsageStore();
    usageStore.resetResults.set('dev-missing', undefined);

    const app = buildApp({ auditLogRepository: auditRepo, usageStore });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'reset-nf' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('not_found');
    expect(res.body.data.message).toContain('dev-missing');
  });

  it('replays APPROVE_QUOTA_REQUEST with success outcome', async () => {
    const req: QuotaRequest = {
      id: 'qr-approve-1',
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'need more quota',
      status: 'pending',
      createdAt: new Date(),
    };
    setQuotaRequestStore(makeQuotaStore([req]));

    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'qa-1',
      event: 'APPROVE_QUOTA_REQUEST',
      details: { requestId: 'qr-approve-1', adminNotes: 'approved during replay' },
    }));

    const app = buildApp({ auditLogRepository: auditRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'qa-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('success');
    expect(res.body.data.originalEvent).toBe('APPROVE_QUOTA_REQUEST');

    const store = getQuotaRequestStore();
    const updated = await store.findById('qr-approve-1');
    expect(updated?.status).toBe('approved');
    expect(updated?.resolvedBy).toBe('admin-api-key');
  });

  it('replays APPROVE_QUOTA_REQUEST with already_resolved outcome', async () => {
    const req: QuotaRequest = {
      id: 'qr-already',
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'x',
      status: 'approved',
      createdAt: new Date(),
      resolvedAt: new Date(),
      resolvedBy: 'prior-admin',
    };
    setQuotaRequestStore(makeQuotaStore([req]));

    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'qa-ar',
      event: 'APPROVE_QUOTA_REQUEST',
      details: { requestId: 'qr-already' },
    }));

    const app = buildApp({ auditLogRepository: auditRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'qa-ar' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('already_resolved');
    expect(res.body.data.message).toContain('qr-already');
  });

  it('replays REJECT_QUOTA_REQUEST with success outcome', async () => {
    const req: QuotaRequest = {
      id: 'qr-reject-1',
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'need',
      status: 'pending',
      createdAt: new Date(),
    };
    setQuotaRequestStore(makeQuotaStore([req]));

    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'qr-1',
      event: 'REJECT_QUOTA_REQUEST',
      details: { requestId: 'qr-reject-1', adminNotes: 'rejected during replay' },
    }));

    const app = buildApp({ auditLogRepository: auditRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'qr-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('success');

    const store = getQuotaRequestStore();
    const updated = await store.findById('qr-reject-1');
    expect(updated?.status).toBe('rejected');
  });

  it('replays GRANT_PREPAID_CREDITS with success outcome', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'grant-1',
      event: 'GRANT_PREPAID_CREDITS',
      details: { userId: 'u-grant-1', amountUsdc: '100.00', campaign: 'GrantFox FWC26' },
    }));
    const creditsRepo = new MockCreditsRepo();

    const app = buildApp({ auditLogRepository: auditRepo, creditsRepository: creditsRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'grant-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('success');
    expect(creditsRepo.grantCalls).toEqual([
      { userId: 'u-grant-1', amountUsdc: '100.00' },
    ]);
  });

  it('replays SOFT_DELETE_API with success outcome', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'del-1',
      event: 'SOFT_DELETE_API',
      details: { apiId: 42 },
    }));
    const apiRepo = new MockApiRepo();
    apiRepo.deleteResults.set(42, true);

    const app = buildApp({ auditLogRepository: auditRepo, apiRepository: apiRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'del-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('success');
  });

  it('replays SOFT_DELETE_API with not_found outcome when already deleted', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'del-nf',
      event: 'SOFT_DELETE_API',
      details: { apiId: 99 },
    }));
    const apiRepo = new MockApiRepo();
    apiRepo.deleteResults.set(99, false);

    const app = buildApp({ auditLogRepository: auditRepo, apiRepository: apiRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'del-nf' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('not_found');
  });

  it('replays RESTORE_API with success outcome', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'rst-1',
      event: 'RESTORE_API',
      details: { apiId: 7 },
    }));
    const apiRepo = new MockApiRepo();

    const app = buildApp({ auditLogRepository: auditRepo, apiRepository: apiRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'rst-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('success');
  });

  it('records AUDIT_REPLAYED audit event on success', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'logged-1',
      event: 'SOFT_DELETE_API',
      details: { apiId: 10 },
    }));
    const apiRepo = new MockApiRepo();

    const app = buildApp({ auditLogRepository: auditRepo, apiRepository: apiRepo });

    await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'logged-1' })
      .set('x-admin-api-key', ADMIN_KEY)
      .set('x-request-id', 'cor-abc');

    expect(logger.audit).toHaveBeenCalledWith(
      'AUDIT_REPLAYED',
      'admin-api-key',
      expect.objectContaining({
        originalEntryId: 'logged-1',
        originalEvent: 'SOFT_DELETE_API',
        outcome: 'success',
        correlationId: 'cor-abc',
      }),
    );
  });

  it('returns AUDIT_DETAILS_INCOMPLETE when details lack required fields', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'inc-1',
      event: 'GRANT_PREPAID_CREDITS',
      details: { userId: 'only-user-id' }, // missing amountUsdc
    }));
    const app = buildApp({ auditLogRepository: auditRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'inc-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUDIT_DETAILS_INCOMPLETE');
  });
});

// ---------------------------------------------------------------------------
// Response shape (standardized envelope)
// ---------------------------------------------------------------------------

describe('POST /api/admin/audit/replay — response envelope', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = JWT_SECRET;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
    jest.restoreAllMocks();
  });

  it('wraps the result in a { data } envelope on success', async () => {
    const auditRepo = new InMemoryAuditRepo();
    auditRepo.setEntry(baseEntry({
      id: 'env-1',
      event: 'RESTORE_API',
      details: { apiId: 1 },
    }));
    const apiRepo = new MockApiRepo();

    const app = buildApp({ auditLogRepository: auditRepo, apiRepository: apiRepo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'env-1' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('entryId', 'env-1');
    expect(res.body.data).toHaveProperty('outcome', 'success');
  });

  it('returns a standardized error envelope on 400 invalid input', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({})
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
  });

  it('returns a standardized error envelope on 404', async () => {
    const app = buildApp({ auditLogRepository: new InMemoryAuditRepo() });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'env-nf' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'AUDIT_ENTRY_NOT_FOUND');
    expect(res.body).toHaveProperty('message');
  });

  it('returns a standardized error envelope on internal error', async () => {
    const repo = new InMemoryAuditRepo();
    jest.spyOn(repo, 'findById').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const app = buildApp({ auditLogRepository: repo });

    const res = await request(app)
      .post('/api/admin/audit/replay')
      .send({ entryId: 'env-500' })
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
  });
});
