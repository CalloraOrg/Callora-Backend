import request from 'supertest';
import express from 'express';
import { createDeveloperRouter } from './developerRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { Developer } from '../db/schema.js';
import type { UpdateDeveloperProfileInput } from '../types/developer.js';

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
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/developers/revenue');
    expect(res.status).toBe(401);
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
