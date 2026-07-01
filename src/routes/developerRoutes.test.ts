import request from 'supertest';
import express from 'express';
import { createDeveloperRouter } from './developerRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { Developer } from '../db/schema.js';
import type { UpdateDeveloperProfileInput } from '../types/developer.js';
import { apiKeyRepository } from '../repositories/apiKeyRepository.js';

const mockSettlementStore = {
  create: jest.fn(),
  updateStatus: jest.fn(),
  getDeveloperSettlements: jest.fn(),
};

const mockUsageStore = {
  record: jest.fn(),
  hasEvent: jest.fn(),
  getEvents: jest.fn(),
  getUnsettledEvents: jest.fn(),
  markAsSettled: jest.fn(),
};

const makeDeveloper = (overrides: Partial<Developer> = {}): Developer => ({
  id: 1,
  user_id: 'dev-1',
  name: null,
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const mockDeveloperRepository = {
  findByUserId: jest.fn(),
  getOrCreateByUserId: jest.fn(),
  upsertProfile: jest.fn<Promise<Developer>, [string, UpdateDeveloperProfileInput]>(),
};

const app = express();
app.use(express.json());
// Mount the router
app.use('/api/developers', createDeveloperRouter({
  settlementStore: mockSettlementStore as any,
  usageStore: mockUsageStore as any,
  developerRepository: mockDeveloperRepository as any,
}));
// Error handler to catch UnauthorizedError
app.use(errorHandler);

describe('GET /api/developers/revenue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettlementStore.getDeveloperSettlements.mockReturnValue([]);
    mockUsageStore.getUnsettledEvents.mockReturnValue([]);
    // Default: findByUserId returns a developer profile for 'dev-1'
    mockDeveloperRepository.findByUserId.mockImplementation((userId: string) =>
      userId === 'dev-1'
        ? Promise.resolve(makeDeveloper({ user_id: 'dev-1' }))
        : Promise.resolve(undefined),
    );
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/revenue');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the authenticated user has no developer profile', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(undefined);

    const res = await request(app)
      .get('/api/developers/revenue')
      .set('x-user-id', 'no-profile-user');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVELOPER_NOT_FOUND');
  });

  it('returns correct revenue summary and clamped limit', async () => {
    mockSettlementStore.getDeveloperSettlements.mockReturnValue([
      { id: 's1', developerId: 'dev-1', amount: 100, status: 'completed' },
      { id: 's2', developerId: 'dev-1', amount: 50, status: 'pending' },
    ]);
    mockUsageStore.getUnsettledEvents.mockReturnValue([
      { id: 'u1', userId: 'dev-1', amountUsdc: 25 },
      { id: 'u2', userId: 'other-dev', amountUsdc: 999 },
    ]);

    const res = await request(app)
      .get('/api/developers/revenue?limit=500')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      total_earned: 175,
      pending: 50,
      available_to_withdraw: 25,
    });
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.settlements.length).toBe(2);
  });

  it('does not return settlements belonging to another developer', async () => {
    // dev-1 is authenticated; settlements are scoped to dev-1 by the store
    mockSettlementStore.getDeveloperSettlements.mockImplementation((devId: string) =>
      devId === 'dev-1'
        ? [{ id: 's1', developerId: 'dev-1', amount: 100, status: 'completed' }]
        : [],
    );
    mockUsageStore.getUnsettledEvents.mockReturnValue([]);

    const res = await request(app)
      .get('/api/developers/revenue')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    // getDeveloperSettlements must be called with dev-1's user_id, not another id
    expect(mockSettlementStore.getDeveloperSettlements).toHaveBeenCalledWith('dev-1');
    expect(mockSettlementStore.getDeveloperSettlements).not.toHaveBeenCalledWith('other-dev');
    expect(res.body.settlements).toHaveLength(1);
    expect(res.body.settlements[0].developerId).toBe('dev-1');
  });
});

describe('GET /api/developers/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/me');
    expect(res.status).toBe(401);
  });

  it('returns the authenticated developer profile and auto-creates on first access', async () => {
    const profile = makeDeveloper({ name: 'Callora Dev', category: 'analytics' });
    mockDeveloperRepository.getOrCreateByUserId.mockResolvedValue(profile);

    const res = await request(app)
      .get('/api/developers/me')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(mockDeveloperRepository.getOrCreateByUserId).toHaveBeenCalledWith('dev-1');
    expect(res.body).toMatchObject({
      id: 1,
      user_id: 'dev-1',
      name: 'Callora Dev',
      category: 'analytics',
    });
  });
});

describe('PATCH /api/developers/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).patch('/api/developers/me').send({ name: 'Nope' });
    expect(res.status).toBe(401);
  });

  it('validates website URL and category enum', async () => {
    const res = await request(app)
      .patch('/api/developers/me')
      .set('x-user-id', 'dev-1')
      .send({ website: 'not-a-url', category: 'unknown' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.website' }),
        expect.objectContaining({ field: 'body.category' }),
      ]),
    );
  });

  it('rejects an empty patch body', async () => {
    const res = await request(app)
      .patch('/api/developers/me')
      .set('x-user-id', 'dev-1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body', message: 'At least one profile field must be provided' }),
      ]),
    );
  });

  it('persists profile updates for the authenticated developer', async () => {
    const updated = makeDeveloper({
      name: 'Updated Dev',
      website: 'https://example.com',
      description: 'Ships API products',
      category: 'developer-tools',
      updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });
    mockDeveloperRepository.upsertProfile.mockResolvedValue(updated);

    const res = await request(app)
      .patch('/api/developers/me')
      .set('x-user-id', 'dev-1')
      .send({
        name: 'Updated Dev',
        website: 'https://example.com',
        description: 'Ships API products',
        category: 'developer-tools',
      });

    expect(res.status).toBe(200);
    expect(mockDeveloperRepository.upsertProfile).toHaveBeenCalledWith('dev-1', {
      name: 'Updated Dev',
      website: 'https://example.com',
      description: 'Ships API products',
      category: 'developer-tools',
    });
    expect(res.body).toMatchObject({
      user_id: 'dev-1',
      name: 'Updated Dev',
      website: 'https://example.com',
      category: 'developer-tools',
    });
  });
});

describe('GET /api/developers/me/keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiKeyRepository.clear();
    // Default: findByUserId returns a developer profile for 'dev-1'
    mockDeveloperRepository.findByUserId.mockImplementation((userId: string) =>
      userId === 'dev-1'
        ? Promise.resolve(makeDeveloper({ user_id: 'dev-1' }))
        : Promise.resolve(undefined),
    );
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/me/keys');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the authenticated user has no developer profile', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(undefined);

    const res = await request(app)
      .get('/api/developers/me/keys')
      .set('x-user-id', 'no-profile-user');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVELOPER_NOT_FOUND');
  });

  it('retrieves only that developer\'s API keys and excludes sensitive fields', async () => {
    // Create key for dev-1
    const key1 = apiKeyRepository.create({
      apiId: 'api-1',
      userId: 'dev-1',
      scopes: ['read'],
      rateLimitPerMinute: null,
    });

    // Create key for dev-2
    apiKeyRepository.create({
      apiId: 'api-1',
      userId: 'dev-2',
      scopes: ['read'],
      rateLimitPerMinute: null,
    });

    const res = await request(app)
      .get('/api/developers/me/keys')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(key1.id);
    expect(res.body.data[0].prefix).toBe(key1.prefix);
    expect(res.body.data[0].created_at).toBe(key1.createdAt.toISOString());
    expect(res.body.data[0].last_used_at).toBeNull();
    expect(res.body.data[0].revoked_at).toBeNull();

    // Verify only public-safe fields are present
    const keys = Object.keys(res.body.data[0]);
    expect(keys).toEqual(expect.arrayContaining(['id', 'prefix', 'created_at', 'last_used_at', 'revoked_at']));
    expect(keys.length).toBe(5);

    // Verify secret fields are NOT returned
    expect(res.body.data[0]).not.toHaveProperty('key');
    expect(res.body.data[0]).not.toHaveProperty('keyHash');
    expect(res.body.data[0]).not.toHaveProperty('key_hash');
    expect(res.body.data[0]).not.toHaveProperty('scopes');
    expect(res.body.data[0]).not.toHaveProperty('userId');
    expect(res.body.data[0]).not.toHaveProperty('user_id');
    expect(JSON.stringify(res.body)).not.toContain(key1.key);
  });

  it('supports cursor-based pagination and correctly updates nextCursor/hasMore', async () => {
    const now = new Date();
    // Create 3 keys for dev-1 at distinct timestamps (or different IDs for sorting stability)
    const key1 = apiKeyRepository.create({ apiId: 'api-1', userId: 'dev-1', scopes: ['*'], rateLimitPerMinute: null });
    const keysInRepo = apiKeyRepository.listForTesting();
    
    // key1 created first (oldest)
    keysInRepo[0].createdAt = new Date(now.getTime() - 3000);
    
    const key2 = apiKeyRepository.create({ apiId: 'api-1', userId: 'dev-1', scopes: ['*'], rateLimitPerMinute: null });
    keysInRepo[1].createdAt = new Date(now.getTime() - 2000);
    
    const key3 = apiKeyRepository.create({ apiId: 'api-1', userId: 'dev-1', scopes: ['*'], rateLimitPerMinute: null });
    keysInRepo[2].createdAt = new Date(now.getTime() - 1000);

    // Fetch page 1 (limit 2) -> should return key3, key2 (sorted by createdAt desc)
    const page1 = await request(app)
      .get('/api/developers/me/keys?limit=2')
      .set('x-user-id', 'dev-1');

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0].id).toBe(key3.id);
    expect(page1.body.data[1].id).toBe(key2.id);
    expect(page1.body.meta.hasMore).toBe(true);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    const nextCursor = page1.body.meta.nextCursor;

    // Fetch page 2 using the cursor
    const page2 = await request(app)
      .get(`/api/developers/me/keys?limit=2&cursor=${encodeURIComponent(nextCursor)}`)
      .set('x-user-id', 'dev-1');

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].id).toBe(key1.id);
    expect(page2.body.meta.hasMore).toBe(false);
    expect(page2.body.meta.nextCursor).toBeNull();
  });

  it('rejects invalid cursor format', async () => {
    const res = await request(app)
      .get('/api/developers/me/keys?cursor=invalid-non-base64-json')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.message).toBe('Invalid cursor');
  });

  it('returns revoked keys with revoked_at correctly populated', async () => {
    const key = apiKeyRepository.create({
      apiId: 'api-1',
      userId: 'dev-1',
      scopes: ['*'],
      rateLimitPerMinute: null,
    });

    apiKeyRepository.revoke(key.id, 'dev-1');

    const res = await request(app)
      .get('/api/developers/me/keys')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(key.id);
    expect(res.body.data[0].revoked_at).not.toBeNull();
    expect(new Date(res.body.data[0].revoked_at).getTime()).toBeCloseTo(Date.now().valueOf(), -3); // Within 1 second
  });
});

