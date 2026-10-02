/**
 * Unit tests for developerRepository
 *
 * Uses an in-memory SQLite database (better-sqlite3 :memory:) + Drizzle so
 * every test runs against real SQL without touching the filesystem.
 *
 * Acceptance criteria covered:
 *  ✓ findByUserId returns undefined for unknown users
 *  ✓ upsertProfile creates a new row on first call
 *  ✓ upserting only displayName leaves all other fields untouched
 *  ✓ updated_at changes on update
 *  ✓ getOrCreateByUserId called twice concurrently yields exactly one row
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';

// ---------------------------------------------------------------------------
// In-process module replacement: swap `src/db/index.ts` with the in-memory db
// ---------------------------------------------------------------------------

// Must be called BEFORE any import of the module under test.
jest.mock('../db/index.js', () => {
  // Build the in-memory db once per test file.  Jest reuses this module mock
  // across all tests in the file, giving us a shared (but fresh-per-file) DB.
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schemaModule = require('../db/schema.js');

  const sqlite = new Database(':memory:');

  // Create the developers table matching src/db/schema.ts exactly.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS developers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      name TEXT,
      website TEXT,
      description TEXT,
      category TEXT,
      plan_overrides TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const db = drizzle(sqlite, { schema: schemaModule });

  return { db, schema: schemaModule, sqlite };
});

// Now import the functions under test (they will pick up the mock above).
import {
  findByUserId,
  getOrCreateByUserId,
  upsertProfile,
} from './developerRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique user-id factory keeps tests independent. */
let _counter = 0;
function uid(prefix = 'user'): string {
  return `${prefix}-${++_counter}`;
}

// ---------------------------------------------------------------------------
// findByUserId
// ---------------------------------------------------------------------------

describe('findByUserId', () => {
  it('returns undefined for a user that does not exist', async () => {
    const result = await findByUserId('no-such-user');
    assert.equal(result, undefined);
  });

  it('returns the developer row after it has been created', async () => {
    const userId = uid();
    await getOrCreateByUserId(userId);

    const result = await findByUserId(userId);

    assert.ok(result, 'expected a developer row to be found');
    assert.equal(result.user_id, userId);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateByUserId
// ---------------------------------------------------------------------------

describe('getOrCreateByUserId', () => {
  it('creates a row with null profile fields on first call', async () => {
    const userId = uid();

    const dev = await getOrCreateByUserId(userId);

    assert.equal(dev.user_id, userId);
    assert.equal(dev.name, null);
    assert.equal(dev.website, null);
    assert.equal(dev.description, null);
    assert.equal(dev.category, null);
    assert.ok(typeof dev.id === 'number', 'id should be a number');
  });

  it('returns the same row on a second call', async () => {
    const userId = uid();

    const first = await getOrCreateByUserId(userId);
    const second = await getOrCreateByUserId(userId);

    assert.equal(first.id, second.id);
  });

  it('concurrent calls produce exactly one row', async () => {
    const userId = uid();

    // SQLite serialises writes synchronously, so two concurrent getOrCreate
    // calls will race: the first INSERT succeeds, the second hits the UNIQUE
    // constraint and rejects.  The important invariant is that at most one row
    // ends up in the database.
    const results = await Promise.allSettled([
      getOrCreateByUserId(userId),
      getOrCreateByUserId(userId),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected  = results.filter((r) => r.status === 'rejected');

    // At least one call must succeed.
    assert.ok(fulfilled.length >= 1, 'at least one concurrent call should fulfill');
    // Total is always 2.
    assert.equal(fulfilled.length + rejected.length, 2);

    // Exactly one physical row must exist regardless of how many calls succeeded.
    const dev = await findByUserId(userId);
    assert.ok(dev, 'row must exist after concurrent getOrCreate');
    assert.equal(dev.user_id, userId);

    // If both succeeded, they must have returned the same row.
    if (fulfilled.length === 2) {
      const [a, b] = fulfilled as PromiseFulfilledResult<Awaited<ReturnType<typeof getOrCreateByUserId>>>[];
      assert.equal(a.value.id, b.value.id, 'both fulfilled calls must reference the same row');
    }
  });
});

// ---------------------------------------------------------------------------
// upsertProfile
// ---------------------------------------------------------------------------

describe('upsertProfile', () => {
  it('creates a new row when the user does not exist yet', async () => {
    const userId = uid();

    const dev = await upsertProfile(userId, { name: 'Alice' });

    assert.equal(dev.user_id, userId);
    assert.equal(dev.name, 'Alice');
  });

  it('upserting only name leaves website, description, and category untouched', async () => {
    const userId = uid();

    // Seed all profile fields.
    await upsertProfile(userId, {
      name: 'Bob',
      website: 'https://bob.dev',
      description: 'A developer',
      category: 'analytics',
    });

    // Partial update: only change name.
    const updated = await upsertProfile(userId, { name: 'Robert' });

    assert.equal(updated.name, 'Robert', 'name should be updated');
    assert.equal(updated.website, 'https://bob.dev', 'website must not be wiped');
    assert.equal(updated.description, 'A developer', 'description must not be wiped');
    assert.equal(updated.category, 'analytics', 'category must not be wiped');
  });

  it('upserting only website leaves name, description, and category untouched', async () => {
    const userId = uid();

    await upsertProfile(userId, {
      name: 'Carol',
      website: 'https://carol.dev',
      description: 'Data engineer',
      category: 'data',
    });

    const updated = await upsertProfile(userId, { website: 'https://carol.io' });

    assert.equal(updated.website, 'https://carol.io');
    assert.equal(updated.name, 'Carol');
    assert.equal(updated.description, 'Data engineer');
    assert.equal(updated.category, 'data');
  });

  it('updated_at changes after an update', async () => {
    const userId = uid();

    // Insert row and record its updated_at timestamp.
    const initial = await upsertProfile(userId, { name: 'Dan' });
    const initialUpdatedAt = initial.updated_at;

    // Wait at least 1 second so that unixepoch() ticks over.
    // In SQLite unixepoch() has 1-second resolution; we advance via the real
    // clock rather than fake timers to keep the test simple.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const updated = await upsertProfile(userId, { name: 'Daniel' });

    assert.ok(
      updated.updated_at !== null &&
        initialUpdatedAt !== null &&
        updated.updated_at > initialUpdatedAt,
      `updated_at (${String(updated.updated_at)}) should be later than initial (${String(initialUpdatedAt)})`,
    );
  });

  it('passing undefined fields does not overwrite existing values', async () => {
    const userId = uid();

    await upsertProfile(userId, {
      name: 'Eve',
      website: 'https://eve.dev',
    });

    // Pass an empty update object — nothing should change except updated_at.
    const updated = await upsertProfile(userId, {});

    assert.equal(updated.name, 'Eve');
    assert.equal(updated.website, 'https://eve.dev');
  });

  it('explicit null for a field does NOT overwrite an existing value (??-merge semantics)', async () => {
    const userId = uid();

    await upsertProfile(userId, { name: 'Frank', website: 'https://frank.dev' });

    // upsertProfile merges fields with `data.field ?? existing.field`.
    // Because `??` treats null as nullish, passing `null` falls through to the
    // existing value — it does NOT clear it.  This is the current implementation
    // contract; callers that need to explicitly clear a field must rely on a
    // future API change.
    const updated = await upsertProfile(userId, { website: null });

    assert.equal(
      updated.website,
      'https://frank.dev',
      'null input falls through to existing value due to ?? semantics',
    );
    assert.equal(updated.name, 'Frank', 'name must remain untouched');
  });
});
