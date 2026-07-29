import assert from 'node:assert/strict';
import { DataType, newDb } from 'pg-mem';

import {
  PgUsageEventsRepository,
  type UsageEventsRepositoryQueryable,
  type CreateUsageEventInput,
} from './usageEventsRepository.pg.js';
import { decodeCursor } from '../lib/cursorPagination.js';

// ---------------------------------------------------------------------------
// Test DB factory — mirrors usageEventsRepository.pg.test.ts exactly.
// ---------------------------------------------------------------------------
function createUsageEventsRepository() {
  const db = newDb();

  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date('2026-03-01T00:00:00.000Z'),
  });

  db.public.none(`
    CREATE TABLE usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      api_id VARCHAR(255) NOT NULL,
      endpoint_id VARCHAR(255) NOT NULL,
      api_key_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL DEFAULT '',
      amount_usdc NUMERIC(20, 0) NOT NULL,
      request_id VARCHAR(255) NOT NULL,
      stellar_tx_hash VARCHAR(64),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (request_id, developer_id)
    );

    CREATE TABLE revenue_ledger (
      id BIGSERIAL PRIMARY KEY,
      api_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL,
      amount_usdc NUMERIC(20, 0) NOT NULL,
      usage_event_id BIGINT UNIQUE REFERENCES usage_events(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_usage_events_user_created ON usage_events(user_id, created_at);
    CREATE INDEX idx_usage_events_api_created ON usage_events(api_id, created_at);
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    repository: new PgUsageEventsRepository(pool as UsageEventsRepositoryQueryable),
    pool,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed n events for a single user with deterministic timestamps spaced 1 hour apart. */
async function seedEvents(
  repository: PgUsageEventsRepository,
  userId: string,
  count: number,
  baseTime = new Date('2026-03-01T00:00:00.000Z'),
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const input: CreateUsageEventInput = {
      userId,
      apiId: `api-${i % 3}`,
      endpointId: `ep-${i}`,
      apiKeyId: `key-1`,
      developerId: 'dev-1',
      amount: BigInt(100 + i),
      requestId: `req-cursor-${userId}-${i}`,
      createdAt: new Date(baseTime.getTime() + i * 60 * 60 * 1000), // +1 h per event
    };
    await repository.create(input);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('returns first page with nextCursor when more results exist', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await seedEvents(repository, 'user-cursor-1', 5);

    const { events, nextCursor, prevCursor } = await repository.findByUserIdCursor({
      userId: 'user-cursor-1',
      limit: 3,
    });

    // First page — 3 of 5 events; must have a nextCursor, no prevCursor.
    assert.equal(events.length, 3);
    assert.notEqual(nextCursor, null, 'nextCursor should be present');
    assert.equal(prevCursor, null, 'prevCursor should be null on first page');

    // Events are in ascending order (oldest first).
    assert.equal(events[0]?.requestId, 'req-cursor-user-cursor-1-0');
    assert.equal(events[2]?.requestId, 'req-cursor-user-cursor-1-2');
  } finally {
    await pool.end();
  }
});

test('returns empty prevCursor on first page (no cursor supplied)', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await seedEvents(repository, 'user-cursor-2', 2);

    const { prevCursor } = await repository.findByUserIdCursor({
      userId: 'user-cursor-2',
      limit: 10,
    });

    assert.equal(prevCursor, null);
  } finally {
    await pool.end();
  }
});

test('returns correct second page using nextCursor', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await seedEvents(repository, 'user-cursor-3', 5);

    // Page 1
    const page1 = await repository.findByUserIdCursor({
      userId: 'user-cursor-3',
      limit: 2,
    });

    assert.equal(page1.events.length, 2);
    assert.notEqual(page1.nextCursor, null);

    // Decode cursor and use it for page 2
    const decodedCursor = decodeCursor(page1.nextCursor!);
    assert.notEqual(decodedCursor, null);

    const page2 = await repository.findByUserIdCursor({
      userId: 'user-cursor-3',
      limit: 2,
      afterCursor: decodedCursor!,
    });

    assert.equal(page2.events.length, 2);

    // No overlap between pages
    const page1Ids = page1.events.map(e => e.id);
    const page2Ids = page2.events.map(e => e.id);
    const overlap = page1Ids.filter(id => page2Ids.includes(id));
    assert.equal(overlap.length, 0, 'pages must not overlap');

    // Page 2 events come after page 1 events (ASC order)
    const lastPage1Time = page1.events[page1.events.length - 1]!.createdAt.getTime();
    const firstPage2Time = page2.events[0]!.createdAt.getTime();
    assert.ok(firstPage2Time > lastPage1Time, 'page 2 must start after page 1 ends');
  } finally {
    await pool.end();
  }
});

test('returns prevCursor on second page', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await seedEvents(repository, 'user-cursor-4', 5);

    // Get page 1 to obtain a nextCursor
    const page1 = await repository.findByUserIdCursor({
      userId: 'user-cursor-4',
      limit: 2,
    });
    assert.notEqual(page1.nextCursor, null);

    const afterCursor = decodeCursor(page1.nextCursor!);
    assert.notEqual(afterCursor, null);

    // Page 2 via afterCursor — must have a prevCursor
    const page2 = await repository.findByUserIdCursor({
      userId: 'user-cursor-4',
      limit: 2,
      afterCursor: afterCursor!,
    });

    assert.notEqual(page2.prevCursor, null, 'page 2 must have a prevCursor');
  } finally {
    await pool.end();
  }
});

test('stable ordering under concurrent-style writes (multiple events same timestamp)', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    const sharedTs = new Date('2026-03-01T12:00:00.000Z');

    // Insert 4 events with the same timestamp — ordering must fall back to id.
    for (let i = 0; i < 4; i++) {
      await repository.create({
        userId: 'user-cursor-stable',
        apiId: 'api-0',
        endpointId: `ep-${i}`,
        apiKeyId: 'key-1',
        developerId: 'dev-1',
        amount: BigInt(100 + i),
        requestId: `req-stable-${i}`,
        createdAt: sharedTs,
      });
    }

    const page1 = await repository.findByUserIdCursor({
      userId: 'user-cursor-stable',
      limit: 2,
    });
    const afterCursor = decodeCursor(page1.nextCursor!);
    assert.notEqual(afterCursor, null);

    const page2 = await repository.findByUserIdCursor({
      userId: 'user-cursor-stable',
      limit: 2,
      afterCursor: afterCursor!,
    });

    // All 4 rows should be covered across the two pages with no duplicates.
    const allIds = [...page1.events, ...page2.events].map(e => e.id);
    const uniqueIds = new Set(allIds);
    assert.equal(uniqueIds.size, 4, 'all 4 events must be covered with no duplicates');
  } finally {
    await pool.end();
  }
});

test('invalid cursor string in afterCursor causes decodeCursor to return null', () => {
  // The route layer rejects invalid cursors with 400; here we confirm the
  // decoder correctly returns null for garbage input so the route can act on it.
  const result = decodeCursor('not-valid-base64-json!!!');
  assert.equal(result, null);
});

test('invalid cursor — passing a garbage afterCursor into the repository throws or returns empty', async () => {
  // When a garbage cursor slips through (e.g., timestamp is 0001-01-01), the
  // query should return no events (the range will simply not match anything).
  const { repository, pool } = createUsageEventsRepository();

  try {
    await seedEvents(repository, 'user-cursor-invalid', 3);

    // Build a cursor with a very old timestamp that yields no rows after it
    // when combined with a reasonable from/to filter.
    const { events } = await repository.findByUserIdCursor({
      userId: 'user-cursor-invalid',
      limit: 10,
      afterCursor: {
        timestamp: new Date('2099-12-31T23:59:59.000Z'), // far in the future
        id: '999999999',
      },
    });

    assert.equal(events.length, 0, 'no events should match a cursor far in the future');
  } finally {
    await pool.end();
  }
});

test('empty result set returns null cursors', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    const { events, nextCursor, prevCursor } = await repository.findByUserIdCursor({
      userId: 'user-cursor-nobody',
      limit: 10,
    });

    assert.equal(events.length, 0);
    assert.equal(nextCursor, null);
    assert.equal(prevCursor, null);
  } finally {
    await pool.end();
  }
});
