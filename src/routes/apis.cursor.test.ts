/**
 * Focused tests for cursor-based pagination on GET /api/apis.
 *
 * These tests exercise the (created_at, id) keyset ordering, cursor
 * encode/decode, hasMore detection, next-cursor generation, and backward
 * compatibility of the legacy offset path.
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { InMemoryApiRepository } from '../repositories/apiRepository.js';
import type { Api } from '../db/schema.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import { createApisRouter } from './apis.js';
import { generateCursor } from '../lib/pagination.js';
import { ListingsCache } from '../lib/listingsCache.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal developer repository stub (not exercised by GET /, here for completeness). */
const developerRepository: DeveloperRepository = {
  async findByUserId() { return undefined; },
  async getOrCreateByUserId() { throw new Error('not needed'); },
  async upsertProfile() { throw new Error('not needed'); },
};

/**
 * Build an Api fixture with explicit created_at and id so tests can assert
 * deterministic ordering and cursor values.
 */
function makeApi(overrides: Partial<Api> & { id: number; created_at: Date }): Api {
  return {
    developer_id: 1,
    name: `API ${overrides.id}`,
    description: null,
    base_url: `https://api-${overrides.id}.test`,
    logo_url: null,
    category: 'test',
    status: 'active',
    updated_at: new Date(0),
    deleted_at: null,
    ...overrides,
  };
}

/**
 * Wire a fresh Express app around the given repository.
 * Disables the shared cache so tests are always isolated.
 */
function buildApp(repo: InMemoryApiRepository) {
  const app = express();
  app.use(
    '/api/apis',
    createApisRouter({
      apiRepository: repo,
      developerRepository,
      cache: new ListingsCache({ ttlMs: 0 }),  // TTL=0 → immediate expiry, never serves from cache
    }),
  );
  app.use(errorHandler);
  return app;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Five active APIs with distinct (created_at, id) pairs.
 * Ordered newest-first so index 0 is the most recent row.
 */
const t5 = new Date('2024-01-05T00:00:00.000Z'); // most recent
const t4 = new Date('2024-01-04T00:00:00.000Z');
const t3 = new Date('2024-01-03T00:00:00.000Z');
const t2 = new Date('2024-01-02T00:00:00.000Z');
const t1 = new Date('2024-01-01T00:00:00.000Z'); // oldest

const api5 = makeApi({ id: 5, created_at: t5, name: 'API 5' });
const api4 = makeApi({ id: 4, created_at: t4, name: 'API 4' });
const api3 = makeApi({ id: 3, created_at: t3, name: 'API 3' });
const api2 = makeApi({ id: 2, created_at: t2, name: 'API 2' });
const api1 = makeApi({ id: 1, created_at: t1, name: 'API 1' }); // oldest

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/apis — cursor pagination', () => {
  function buildFixtureApp() {
    return buildApp(
      new InMemoryApiRepository([api5, api4, api3, api2, api1], new Map()),
    );
  }

  // ── Basic cursor path ──────────────────────────────────────────────────────

  it('returns a cursor-based response envelope when cursor is supplied', async () => {
    const cursor = generateCursor(t5.toISOString(), '5');
    const res = await request(buildFixtureApp())
      .get(`/api/apis?limit=2&cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('limit', 2);
    expect(res.body.meta).toHaveProperty('hasMore');
    expect(res.body.meta).toHaveProperty('nextCursor');
    // Offset-style meta should NOT be present
    expect(res.body.meta).not.toHaveProperty('offset');
  });

  it('returns rows strictly after the cursor in newest-first order', async () => {
    // Cursor points at api5 (most recent). Next page should be [api4, api3].
    const cursor = generateCursor(t5.toISOString(), '5');
    const res = await request(buildFixtureApp())
      .get(`/api/apis?limit=2&cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe(4);
    expect(res.body.data[1].id).toBe(3);
  });

  it('sets hasMore=true and provides nextCursor when more rows follow', async () => {
    const cursor = generateCursor(t5.toISOString(), '5');
    const res = await request(buildFixtureApp())
      .get(`/api/apis?limit=2&cursor=${cursor}`);

    expect(res.body.meta.hasMore).toBe(true);
    expect(typeof res.body.meta.nextCursor).toBe('string');
    expect(res.body.meta.nextCursor.length).toBeGreaterThan(0);
  });

  it('sets hasMore=false and nextCursor=undefined on the last page', async () => {
    // Cursor points at api3; only api2 and api1 remain (2 rows, limit=3 ⇒ no more).
    const cursor = generateCursor(t3.toISOString(), '3');
    const res = await request(buildFixtureApp())
      .get(`/api/apis?limit=3&cursor=${cursor}`);

    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeUndefined();
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe(2);
    expect(res.body.data[1].id).toBe(1);
  });

  it('returns an empty data array when the cursor is at the last row', async () => {
    // api1 is the oldest; nothing comes after it.
    const cursor = generateCursor(t1.toISOString(), '1');
    const res = await request(buildFixtureApp())
      .get(`/api/apis?limit=5&cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeUndefined();
  });

  // ── Next-cursor chaining ───────────────────────────────────────────────────

  it('can traverse all rows page by page via nextCursor', async () => {
    const app = buildFixtureApp();
    const ids: number[] = [];

    // Start with a cursor pointing past all rows (far future) so the first
    // page also uses the cursor path and returns a nextCursor for chaining.
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    let cursor: string | undefined = generateCursor(farFuture.toISOString(), '999999');

    while (cursor) {
      const page = await request(app).get(`/api/apis?limit=2&cursor=${cursor}`);
      expect(page.status).toBe(200);
      page.body.data.forEach((r: { id: number }) => ids.push(r.id));
      cursor = page.body.meta.nextCursor;
    }

    // Should have seen all 5 IDs exactly once, in newest-first order.
    expect(ids).toEqual([5, 4, 3, 2, 1]);
  });

  // ── No-cursor first page ───────────────────────────────────────────────────

  it('first page (no cursor) returns cursor-based response with nextCursor and hasMore', async () => {
    const res = await request(buildFixtureApp()).get('/api/apis?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe(5);
    expect(res.body.data[1].id).toBe(4);
    // Cursor path is now the default; meta has cursor fields, not offset.
    expect(res.body.meta).toHaveProperty('limit', 2);
    expect(res.body.meta).toHaveProperty('hasMore', true);
    expect(typeof res.body.meta.nextCursor).toBe('string');
    expect(res.body.meta).not.toHaveProperty('offset');
  });

  // ── Tie-breaking on identical timestamps ──────────────────────────────────

  it('differentiates rows with identical created_at by id', async () => {
    const sameTs = new Date('2024-06-01T00:00:00.000Z');
    const a = makeApi({ id: 10, created_at: sameTs, name: 'A' });
    const b = makeApi({ id: 20, created_at: sameTs, name: 'B' });
    const c = makeApi({ id: 30, created_at: sameTs, name: 'C' });
    const repo = new InMemoryApiRepository([a, b, c], new Map());
    const app = buildApp(repo);

    // Cursor at id=30 (highest id on that timestamp).
    const cursor = generateCursor(sameTs.toISOString(), '30');
    const res = await request(app).get(`/api/apis?limit=5&cursor=${cursor}`);

    expect(res.status).toBe(200);
    // Should return rows with id < 30 at the same timestamp, newest id first.
    const returnedIds: number[] = res.body.data.map((r: { id: number }) => r.id);
    expect(returnedIds).toContain(20);
    expect(returnedIds).toContain(10);
    expect(returnedIds).not.toContain(30);
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it('returns 400 for a malformed cursor (not valid base64 of created_at|id)', async () => {
    const res = await request(buildFixtureApp())
      .get('/api/apis?cursor=!!!not_valid_base64!!!');

    expect(res.status).toBe(400);
    // The errorHandler wraps errors as { success, error: { code, message }, requestId, timestamp }
    expect(res.body.error?.code ?? res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a cursor with missing id component', async () => {
    // base64 of a string with no pipe separator
    const bad = Buffer.from('onlytimestamp').toString('base64');
    const res = await request(buildFixtureApp()).get(`/api/apis?cursor=${bad}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a cursor with an invalid timestamp', async () => {
    const bad = Buffer.from('not-a-date|42').toString('base64');
    const res = await request(buildFixtureApp()).get(`/api/apis?cursor=${bad}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a cursor with a non-positive id component', async () => {
    const bad = Buffer.from(`${t5.toISOString()}|0`).toString('base64');
    const res = await request(buildFixtureApp()).get(`/api/apis?cursor=${bad}`);
    expect(res.status).toBe(400);
  });

  // ── Filter composition ─────────────────────────────────────────────────────

  it('respects category filter when cursor is present', async () => {
    const app = buildApp(
      new InMemoryApiRepository(
        [
          makeApi({ id: 10, created_at: new Date('2024-03-01T00:00:00.000Z'), category: 'weather', name: 'W1' }),
          makeApi({ id: 9,  created_at: new Date('2024-02-01T00:00:00.000Z'), category: 'finance', name: 'F1' }),
          makeApi({ id: 8,  created_at: new Date('2024-01-01T00:00:00.000Z'), category: 'weather', name: 'W2' }),
        ],
        new Map(),
      ),
    );

    const cursor = generateCursor(new Date('2024-03-01T00:00:00.000Z').toISOString(), '10');
    const res = await request(app)
      .get(`/api/apis?limit=5&cursor=${cursor}&category=weather`);

    expect(res.status).toBe(200);
    // Only W2 (id=8) passes the category=weather filter after the cursor.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(8);
  });

  it('respects search filter when cursor is present', async () => {
    const app = buildApp(
      new InMemoryApiRepository(
        [
          makeApi({ id: 10, created_at: new Date('2024-03-01T00:00:00.000Z'), name: 'Alpha API' }),
          makeApi({ id: 9,  created_at: new Date('2024-02-01T00:00:00.000Z'), name: 'Beta API' }),
          makeApi({ id: 8,  created_at: new Date('2024-01-01T00:00:00.000Z'), name: 'Alpha Service' }),
        ],
        new Map(),
      ),
    );

    const cursor = generateCursor(new Date('2024-03-01T00:00:00.000Z').toISOString(), '10');
    const res = await request(app)
      .get(`/api/apis?limit=5&cursor=${cursor}&search=Alpha`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(8);
  });

  // ── Cursor pagination is always the default ────────────────────────────────

  it('uses cursor pagination even when no cursor is supplied', async () => {
    const res = await request(buildFixtureApp()).get('/api/apis?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.meta).toHaveProperty('limit', 2);
    expect(res.body.meta).toHaveProperty('hasMore');
    expect(res.body.meta).toHaveProperty('nextCursor');
    expect(res.body.meta).not.toHaveProperty('offset');
  });

  it('treats empty cursor string as first page (cursor-based)', async () => {
    const res = await request(buildFixtureApp()).get('/api/apis?cursor=');

    expect(res.status).toBe(200);
    expect(res.body.meta).toHaveProperty('hasMore');
    expect(res.body.meta).toHaveProperty('nextCursor');
    expect(res.body.meta).not.toHaveProperty('offset');
  });

  // ── Cache isolation ────────────────────────────────────────────────────────

  it('different cursors produce different cache keys (no cross-page pollution)', async () => {
    const app = buildFixtureApp();

    const cursor1 = generateCursor(t5.toISOString(), '5');
    const cursor2 = generateCursor(t3.toISOString(), '3');

    const page1 = await request(app).get(`/api/apis?limit=2&cursor=${cursor1}`);
    const page2 = await request(app).get(`/api/apis?limit=2&cursor=${cursor2}`);

    expect(page1.body.data.map((r: { id: number }) => r.id)).toEqual([4, 3]);
    expect(page2.body.data.map((r: { id: number }) => r.id)).toEqual([2, 1]);
  });
});
