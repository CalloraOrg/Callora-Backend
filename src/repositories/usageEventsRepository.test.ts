import assert from 'node:assert/strict';

import { InMemoryUsageEventsRepository, type UsageEvent } from './usageEventsRepository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'evt-1',
  developerId: 'dev-1',
  apiId: 'api-weather',
  endpoint: '/current',
  userId: 'user-1',
  occurredAt: new Date('2026-03-15T12:00:00.000Z'),
  revenue: 100n,
  ...overrides,
});

// ---------------------------------------------------------------------------
// findByDeveloper
// ---------------------------------------------------------------------------

describe('InMemoryUsageEventsRepository – findByDeveloper', () => {
  it('returns events matching developerId within the time range', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', occurredAt: new Date('2026-03-10T00:00:00.000Z') }),
      makeEvent({ id: 'e2', occurredAt: new Date('2026-03-20T00:00:00.000Z') }),
      makeEvent({ id: 'e3', occurredAt: new Date('2026-04-01T00:00:00.000Z') }),
    ]);

    const results = await repo.findByDeveloper({
      developerId: 'dev-1',
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    });

    assert.deepEqual(
      results.map((e) => e.id),
      ['e1', 'e2'],
    );
  });

  it('excludes events from other developers', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', developerId: 'dev-1' }),
      makeEvent({ id: 'e2', developerId: 'dev-2' }),
    ]);

    const results = await repo.findByDeveloper({
      developerId: 'dev-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, 'e1');
  });

  it('filters by optional apiId', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', apiId: 'api-weather' }),
      makeEvent({ id: 'e2', apiId: 'api-chat' }),
    ]);

    const results = await repo.findByDeveloper({
      developerId: 'dev-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      apiId: 'api-weather',
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.apiId, 'api-weather');
  });

  it('includes events exactly on the from and to boundaries', async () => {
    const from = new Date('2026-03-01T00:00:00.000Z');
    const to = new Date('2026-03-31T23:59:59.999Z');
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e-from', occurredAt: from }),
      makeEvent({ id: 'e-to', occurredAt: to }),
    ]);

    const results = await repo.findByDeveloper({ developerId: 'dev-1', from, to });

    assert.deepEqual(
      results.map((e) => e.id),
      ['e-from', 'e-to'],
    );
  });

  it('returns an empty array when no events match', async () => {
    const repo = new InMemoryUsageEventsRepository([makeEvent()]);

    const results = await repo.findByDeveloper({
      developerId: 'dev-99',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.deepEqual(results, []);
  });

  it('returns an empty array when the repository is empty', async () => {
    const repo = new InMemoryUsageEventsRepository();

    const results = await repo.findByDeveloper({
      developerId: 'dev-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// findByUser
// ---------------------------------------------------------------------------

describe('InMemoryUsageEventsRepository – findByUser', () => {
  it('returns events matching userId within the time range', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1', occurredAt: new Date('2026-03-10T00:00:00.000Z') }),
      makeEvent({ id: 'e2', userId: 'user-1', occurredAt: new Date('2026-03-20T00:00:00.000Z') }),
      makeEvent({ id: 'e3', userId: 'user-2', occurredAt: new Date('2026-03-15T00:00:00.000Z') }),
    ]);

    const results = await repo.findByUser({
      userId: 'user-1',
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    });

    assert.deepEqual(
      results.map((e) => e.id),
      ['e1', 'e2'],
    );
  });

  it('filters by optional apiId', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1', apiId: 'api-weather' }),
      makeEvent({ id: 'e2', userId: 'user-1', apiId: 'api-chat' }),
    ]);

    const results = await repo.findByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      apiId: 'api-chat',
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.apiId, 'api-chat');
  });

  it('honors the limit parameter', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1' }),
      makeEvent({ id: 'e2', userId: 'user-1' }),
      makeEvent({ id: 'e3', userId: 'user-1' }),
    ]);

    const results = await repo.findByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      limit: 2,
    });

    assert.equal(results.length, 2);
  });

  it('returns all events when limit is not specified', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1' }),
      makeEvent({ id: 'e2', userId: 'user-1' }),
    ]);

    const results = await repo.findByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.equal(results.length, 2);
  });

  it('returns an empty array when limit is 0', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1' }),
      makeEvent({ id: 'e2', userId: 'user-1' }),
    ]);

    const results = await repo.findByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      limit: 0,
    });

    assert.deepEqual(results, []);
  });

  it('returns an empty array when no events match', async () => {
    const repo = new InMemoryUsageEventsRepository([makeEvent()]);

    const results = await repo.findByUser({
      userId: 'user-99',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// developerOwnsApi
// ---------------------------------------------------------------------------

describe('InMemoryUsageEventsRepository – developerOwnsApi', () => {
  it('returns true when the developer has an event for the api', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ developerId: 'dev-1', apiId: 'api-weather' }),
    ]);

    assert.equal(await repo.developerOwnsApi('dev-1', 'api-weather'), true);
  });

  it('returns false when the developer has no event for the api', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ developerId: 'dev-1', apiId: 'api-weather' }),
    ]);

    assert.equal(await repo.developerOwnsApi('dev-1', 'api-chat'), false);
  });

  it('returns false when a different developer owns the api', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ developerId: 'dev-2', apiId: 'api-weather' }),
    ]);

    assert.equal(await repo.developerOwnsApi('dev-1', 'api-weather'), false);
  });

  it('returns false when the repository is empty', async () => {
    const repo = new InMemoryUsageEventsRepository();

    assert.equal(await repo.developerOwnsApi('dev-1', 'api-weather'), false);
  });
});

// ---------------------------------------------------------------------------
// aggregateByDeveloper
// ---------------------------------------------------------------------------

describe('InMemoryUsageEventsRepository – aggregateByDeveloper', () => {
  it('sums calls and revenue per api for the given developer', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', developerId: 'dev-1', apiId: 'api-weather', revenue: 100n }),
      makeEvent({ id: 'e2', developerId: 'dev-1', apiId: 'api-weather', revenue: 200n }),
      makeEvent({ id: 'e3', developerId: 'dev-1', apiId: 'api-chat', revenue: 50n }),
      makeEvent({ id: 'e4', developerId: 'dev-2', apiId: 'api-weather', revenue: 999n }),
    ]);

    const stats = await repo.aggregateByDeveloper('dev-1');

    // Sort for deterministic comparison
    stats.sort((a, b) => a.apiId.localeCompare(b.apiId));

    assert.equal(stats.length, 2);
    assert.deepEqual(stats[0], { apiId: 'api-chat', calls: 1, revenue: 50n });
    assert.deepEqual(stats[1], { apiId: 'api-weather', calls: 2, revenue: 300n });
  });

  it('returns an empty array when the developer has no events', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ developerId: 'dev-2' }),
    ]);

    const stats = await repo.aggregateByDeveloper('dev-1');

    assert.deepEqual(stats, []);
  });

  it('returns an empty array when the repository is empty', async () => {
    const repo = new InMemoryUsageEventsRepository();

    assert.deepEqual(await repo.aggregateByDeveloper('dev-1'), []);
  });

  it('handles zero-revenue events without error', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ developerId: 'dev-1', apiId: 'api-free', revenue: 0n }),
    ]);

    const stats = await repo.aggregateByDeveloper('dev-1');

    assert.equal(stats.length, 1);
    assert.equal(stats[0]?.revenue, 0n);
    assert.equal(stats[0]?.calls, 1);
  });
});

// ---------------------------------------------------------------------------
// aggregateByUser
// ---------------------------------------------------------------------------

describe('InMemoryUsageEventsRepository – aggregateByUser', () => {
  it('returns correct totals and per-api breakdown within the time range', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1', apiId: 'api-weather', revenue: 100n, occurredAt: new Date('2026-03-10T00:00:00.000Z') }),
      makeEvent({ id: 'e2', userId: 'user-1', apiId: 'api-weather', revenue: 200n, occurredAt: new Date('2026-03-20T00:00:00.000Z') }),
      makeEvent({ id: 'e3', userId: 'user-1', apiId: 'api-chat', revenue: 50n, occurredAt: new Date('2026-03-15T00:00:00.000Z') }),
      makeEvent({ id: 'e4', userId: 'user-2', apiId: 'api-weather', revenue: 999n, occurredAt: new Date('2026-03-12T00:00:00.000Z') }),
    ]);

    const result = await repo.aggregateByUser({
      userId: 'user-1',
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    });

    assert.equal(result.totalCalls, 3);
    assert.equal(result.totalRevenue, 350n);

    const breakdown = [...result.breakdownByApi].sort((a, b) => a.apiId.localeCompare(b.apiId));
    assert.deepEqual(breakdown[0], { apiId: 'api-chat', calls: 1, revenue: 50n });
    assert.deepEqual(breakdown[1], { apiId: 'api-weather', calls: 2, revenue: 300n });
  });

  it('filters by optional apiId', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ userId: 'user-1', apiId: 'api-weather', revenue: 100n }),
      makeEvent({ userId: 'user-1', apiId: 'api-chat', revenue: 50n }),
    ]);

    const result = await repo.aggregateByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      apiId: 'api-weather',
    });

    assert.equal(result.totalCalls, 1);
    assert.equal(result.totalRevenue, 100n);
    assert.equal(result.breakdownByApi.length, 1);
    assert.equal(result.breakdownByApi[0]?.apiId, 'api-weather');
  });

  it('excludes events outside the time range', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ userId: 'user-1', revenue: 100n, occurredAt: new Date('2026-02-28T23:59:59.999Z') }),
      makeEvent({ id: 'e-in', userId: 'user-1', revenue: 200n, occurredAt: new Date('2026-03-15T00:00:00.000Z') }),
      makeEvent({ userId: 'user-1', revenue: 300n, occurredAt: new Date('2026-04-01T00:00:00.000Z') }),
    ]);

    const result = await repo.aggregateByUser({
      userId: 'user-1',
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    });

    assert.equal(result.totalCalls, 1);
    assert.equal(result.totalRevenue, 200n);
  });

  it('returns zero totals and empty breakdown when no events match', async () => {
    const repo = new InMemoryUsageEventsRepository([makeEvent()]);

    const result = await repo.aggregateByUser({
      userId: 'user-99',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.equal(result.totalCalls, 0);
    assert.equal(result.totalRevenue, 0n);
    assert.deepEqual(result.breakdownByApi, []);
  });

  it('returns zero totals when the repository is empty', async () => {
    const repo = new InMemoryUsageEventsRepository();

    const result = await repo.aggregateByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.equal(result.totalCalls, 0);
    assert.equal(result.totalRevenue, 0n);
    assert.deepEqual(result.breakdownByApi, []);
  });

  it('handles large bigint revenue values without overflow', async () => {
    const largeRevenue = BigInt(Number.MAX_SAFE_INTEGER) * 1000n;
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'e1', userId: 'user-1', revenue: largeRevenue }),
      makeEvent({ id: 'e2', userId: 'user-1', revenue: largeRevenue }),
    ]);

    const result = await repo.aggregateByUser({
      userId: 'user-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });

    assert.equal(result.totalRevenue, largeRevenue * 2n);
  });
});
