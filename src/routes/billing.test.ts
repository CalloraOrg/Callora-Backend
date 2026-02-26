import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { createApp } from '../app.js';
import {
  InMemoryUsageEventsRepository,
  type UsageEvent,
} from '../repositories/usageEventsRepository.js';
import { InMemoryVaultRepository } from '../repositories/vaultRepository.js';

describe('GET /api/billing/transactions', () => {
  let usageEventsRepository: InMemoryUsageEventsRepository;
  let vaultRepository: InMemoryVaultRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    // Create test data
    const testEvents: UsageEvent[] = [
      {
        id: '1',
        developerId: 'dev1',
        apiId: 'api1',
        endpoint: '/test',
        userId: 'user1',
        occurredAt: new Date('2024-01-15T10:00:00Z'),
        revenue: 100n,
      },
      {
        id: '2',
        developerId: 'dev1',
        apiId: 'api1',
        endpoint: '/test2',
        userId: 'user1',
        occurredAt: new Date('2024-01-16T10:00:00Z'),
        revenue: 200n,
      },
    ];

    usageEventsRepository = new InMemoryUsageEventsRepository(testEvents);
    vaultRepository = new InMemoryVaultRepository();

    app = createApp({
      usageEventsRepository,
      vaultRepository,
    });
  });

  it('should return 401 without authentication', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .query({ from: '2024-01-01', to: '2024-01-31' });

    assert.strictEqual(response.status, 401);
  });

  it('should return 400 if from or to is missing', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user1')
      .query({ from: '2024-01-01' });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error, /from and to are required/);
  });

  it('should return 400 if from is after to', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user1')
      .query({ from: '2024-01-31', to: '2024-01-01' });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error, /from must be before or equal to to/);
  });

  it('should return 400 for invalid type parameter', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user1')
      .query({ from: '2024-01-01', to: '2024-01-31', type: 'invalid' });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error, /type must be one of/);
  });

  it('should return transactions for authenticated user', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user1')
      .query({ from: '2024-01-01', to: '2024-01-31' });

    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.strictEqual(response.body.data.length, 2);
    assert.strictEqual(response.body.data[0].type, 'charge');
  });

  it('should filter by type=charge', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user1')
      .query({ from: '2024-01-01', to: '2024-01-31', type: 'charge' });

    assert.strictEqual(response.status, 200);
    assert.ok(response.body.data.every((tx: any) => tx.type === 'charge'));
  });

  it('should respect limit and offset parameters', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user1')
      .query({ from: '2024-01-01', to: '2024-01-31', limit: 1, offset: 0 });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.length, 1);
    assert.ok(response.body.pagination);
    assert.strictEqual(response.body.pagination.limit, 1);
    assert.strictEqual(response.body.pagination.offset, 0);
  });

  it('should return empty array for user with no transactions', async () => {
    const response = await request(app)
      .get('/api/billing/transactions')
      .set('x-user-id', 'user999')
      .query({ from: '2024-01-01', to: '2024-01-31' });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.length, 0);
  });
});
