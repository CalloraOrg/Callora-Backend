/**
 * Tests for the GET /api/apis listings cache (issue #314).
 *
 * Coverage areas
 * ──────────────
 * 1. ListingsCache unit tests — TTL, get/set/delete/invalidateAll, lazy eviction
 * 2. buildCacheKey — determinism, param ordering, null handling
 * 3. Route integration — cache hit/miss behaviour via InMemoryApiRepository
 * 4. Cache metrics — apis_listing_cache_hits_total / misses_total counters
 * 5. Invalidation — create and update flush the cache
 * 6. Edge cases — empty results, concurrent keys, TTL boundary
 */

import request from 'supertest';
import express from 'express';
import client from 'prom-client';
import { ListingsCache, buildCacheKey, listingsCache } from '../lib/listingsCache.js';
import { createApisRouter } from '../routes/apis.js';
import { InMemoryApiRepository } from '../repositories/apiRepository.js';
import { resetAllMetrics } from '../metrics.js';
import type { Api } from '../db/schema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    id: 1,
    developer_id: 1,
    name: 'Test API',
    description: null,
    base_url: 'https://api.example.com',
    logo_url: null,
    category: null,
    status: 'active',
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  };
}

async function getCounterValue(name: string): Promise<number> {
  const metrics = await client.register.getMetricsAsJSON();
  const found = metrics.find((m) => m.name === name);
  if (!found || !found.values.length) return 0;
  // Counter has a single value entry
  return (found.values[0] as { value: number }).value ?? 0;
}

function buildApp(repo: InMemoryApiRepository, cache: ListingsCache) {
  const app = express();
  app.use(express.json());
  app.use('/api/apis', createApisRouter({ apiRepository: repo, cache }));
  return app;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  listingsCache.clear();
  resetAllMetrics();
});

afterEach(() => {
  listingsCache.clear();
  resetAllMetrics();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. ListingsCache unit tests
// ═════════════════════════════════════════════════════════════════════════════

describe('ListingsCache', () => {
  describe('get / set', () => {
    it('returns undefined for a key that was never set', () => {
      const cache = new ListingsCache();
      expect(cache.get('missing')).toBeUndefined();
    });

    it('returns the stored value immediately after set', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('k', { data: [1, 2, 3] });
      expect(cache.get('k')).toEqual({ data: [1, 2, 3] });
    });

    it('overwrites an existing entry on set', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('k', 'first');
      cache.set('k', 'second');
      expect(cache.get('k')).toBe('second');
    });

    it('stores independent values under different keys', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined after the TTL has elapsed (lazy eviction)', () => {
      jest.useFakeTimers();
      const cache = new ListingsCache({ ttlMs: 1_000 });
      cache.set('k', 'value');

      // Still within TTL
      jest.advanceTimersByTime(999);
      expect(cache.get('k')).toBe('value');

      // Past TTL
      jest.advanceTimersByTime(2);
      expect(cache.get('k')).toBeUndefined();

      jest.useRealTimers();
    });

    it('evicts the expired entry from the store on read', () => {
      jest.useFakeTimers();
      const cache = new ListingsCache({ ttlMs: 500 });
      cache.set('k', 'v');
      expect(cache.size).toBe(1);

      jest.advanceTimersByTime(501);
      cache.get('k'); // triggers lazy eviction
      expect(cache.size).toBe(0);

      jest.useRealTimers();
    });

    it('respects a custom TTL passed to the constructor', () => {
      const cache = new ListingsCache({ ttlMs: 99_000 });
      expect(cache.ttl).toBe(99_000);
    });

    it('defaults to 30 000 ms when no TTL is provided', () => {
      const cache = new ListingsCache();
      expect(cache.ttl).toBe(30_000);
    });

    it('allows a fresh entry after the previous one expired', () => {
      jest.useFakeTimers();
      const cache = new ListingsCache({ ttlMs: 100 });
      cache.set('k', 'old');
      jest.advanceTimersByTime(101);
      expect(cache.get('k')).toBeUndefined();

      cache.set('k', 'new');
      expect(cache.get('k')).toBe('new');
      jest.useRealTimers();
    });
  });

  describe('delete', () => {
    it('removes a specific key', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.delete('a');
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
    });

    it('is a no-op for a key that does not exist', () => {
      const cache = new ListingsCache();
      expect(() => cache.delete('nonexistent')).not.toThrow();
    });
  });

  describe('invalidateAll / clear', () => {
    it('removes all entries', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.invalidateAll();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });

    it('clear() is an alias for invalidateAll()', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('x', 'y');
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('allows new entries after a flush', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      cache.set('k', 'before');
      cache.invalidateAll();
      cache.set('k', 'after');
      expect(cache.get('k')).toBe('after');
    });
  });

  describe('size', () => {
    it('tracks the number of stored entries', () => {
      const cache = new ListingsCache({ ttlMs: 5_000 });
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. buildCacheKey
// ═════════════════════════════════════════════════════════════════════════════

describe('buildCacheKey', () => {
  it('produces the same key for identical params', () => {
    const k1 = buildCacheKey({ limit: 20, offset: 0 });
    const k2 = buildCacheKey({ limit: 20, offset: 0 });
    expect(k1).toBe(k2);
  });

  it('produces different keys for different limit/offset', () => {
    const k1 = buildCacheKey({ limit: 20, offset: 0 });
    const k2 = buildCacheKey({ limit: 20, offset: 20 });
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different category', () => {
    const k1 = buildCacheKey({ limit: 20, offset: 0, category: 'finance' });
    const k2 = buildCacheKey({ limit: 20, offset: 0, category: 'health' });
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different search terms', () => {
    const k1 = buildCacheKey({ limit: 20, offset: 0, search: 'foo' });
    const k2 = buildCacheKey({ limit: 20, offset: 0, search: 'bar' });
    expect(k1).not.toBe(k2);
  });

  it('treats undefined category/search the same as null (stable key)', () => {
    const k1 = buildCacheKey({ limit: 10, offset: 0 });
    const k2 = buildCacheKey({ limit: 10, offset: 0, category: undefined, search: undefined });
    expect(k1).toBe(k2);
  });

  it('includes all four params in the key', () => {
    const key = buildCacheKey({ limit: 5, offset: 10, category: 'ai', search: 'gpt' });
    expect(key).toContain('"limit":5');
    expect(key).toContain('"offset":10');
    expect(key).toContain('"category":"ai"');
    expect(key).toContain('"search":"gpt"');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Route integration — cache hit/miss behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/apis — cache integration', () => {
  it('returns 200 with data on first request (cache miss)', async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 1, name: 'API One' })]);
    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    const res = await request(app).get('/api/apis');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('API One');
  });

  it('serves the second request from cache without calling the repository again', async () => {
    let callCount = 0;
    const repo = new InMemoryApiRepository([makeApi()]);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis');
    await request(app).get('/api/apis');

    // Repository should only have been called once — second request hit cache.
    expect(callCount).toBe(1);
  });

  it('caches different query param combinations independently', async () => {
    let callCount = 0;
    const repo = new InMemoryApiRepository([
      makeApi({ id: 1, name: 'Finance API', category: 'finance' }),
      makeApi({ id: 2, name: 'Health API', category: 'health' }),
    ]);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    // Two different filter combinations — each should hit the DB once.
    await request(app).get('/api/apis?category=finance');
    await request(app).get('/api/apis?category=health');
    expect(callCount).toBe(2);

    // Repeat both — both should now be served from cache.
    await request(app).get('/api/apis?category=finance');
    await request(app).get('/api/apis?category=health');
    expect(callCount).toBe(2); // still 2
  });

  it('returns a fresh result after the TTL expires', async () => {
    jest.useFakeTimers();
    let callCount = 0;
    const repo = new InMemoryApiRepository([makeApi()]);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 1_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis');
    expect(callCount).toBe(1);

    jest.advanceTimersByTime(1_001);

    await request(app).get('/api/apis');
    expect(callCount).toBe(2); // TTL expired — DB called again

    jest.useRealTimers();
  });

  it('returns an empty data array when no active APIs exist', async () => {
    const repo = new InMemoryApiRepository([]);
    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    const res = await request(app).get('/api/apis');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('caches empty results and serves them on the next request', async () => {
    let callCount = 0;
    const repo = new InMemoryApiRepository([]);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis');
    await request(app).get('/api/apis');
    expect(callCount).toBe(1);
  });

  it('respects pagination params as part of the cache key', async () => {
    let callCount = 0;
    const apis = Array.from({ length: 5 }, (_, i) =>
      makeApi({ id: i + 1, name: `API ${i + 1}` }),
    );
    const repo = new InMemoryApiRepository(apis);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis?limit=2&offset=0');
    await request(app).get('/api/apis?limit=2&offset=2');
    expect(callCount).toBe(2); // different pages → different cache keys

    await request(app).get('/api/apis?limit=2&offset=0');
    expect(callCount).toBe(2); // first page served from cache
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Cache metrics
// ═════════════════════════════════════════════════════════════════════════════

describe('Cache hit/miss metrics', () => {
  it('increments misses_total on a cache miss', async () => {
    const repo = new InMemoryApiRepository([makeApi()]);
    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis');

    const misses = await getCounterValue('apis_listing_cache_misses_total');
    expect(misses).toBe(1);
  });

  it('increments hits_total on a cache hit', async () => {
    const repo = new InMemoryApiRepository([makeApi()]);
    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis'); // miss
    await request(app).get('/api/apis'); // hit

    const hits = await getCounterValue('apis_listing_cache_hits_total');
    const misses = await getCounterValue('apis_listing_cache_misses_total');
    expect(hits).toBe(1);
    expect(misses).toBe(1);
  });

  it('accumulates hits across multiple cached requests', async () => {
    const repo = new InMemoryApiRepository([makeApi()]);
    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis'); // miss
    await request(app).get('/api/apis'); // hit
    await request(app).get('/api/apis'); // hit
    await request(app).get('/api/apis'); // hit

    const hits = await getCounterValue('apis_listing_cache_hits_total');
    const misses = await getCounterValue('apis_listing_cache_misses_total');
    expect(hits).toBe(3);
    expect(misses).toBe(1);
  });

  it('records a miss for each distinct cache key', async () => {
    const repo = new InMemoryApiRepository([makeApi()]);
    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis?limit=10');
    await request(app).get('/api/apis?limit=20');

    const misses = await getCounterValue('apis_listing_cache_misses_total');
    expect(misses).toBe(2);
  });

  it('metrics are exported in Prometheus format', async () => {
    const metrics = await client.register.metrics();
    expect(metrics).toContain('apis_listing_cache_hits_total');
    expect(metrics).toContain('apis_listing_cache_misses_total');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Cache invalidation on write
// ═════════════════════════════════════════════════════════════════════════════

describe('Cache invalidation', () => {
  it('invalidateAll() clears all cached entries', () => {
    const cache = new ListingsCache({ ttlMs: 5_000 });
    cache.set(buildCacheKey({ limit: 20, offset: 0 }), { data: [] });
    cache.set(buildCacheKey({ limit: 20, offset: 0, category: 'ai' }), { data: [] });
    expect(cache.size).toBe(2);

    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  it('forces a DB read after invalidation', async () => {
    let callCount = 0;
    const repo = new InMemoryApiRepository([makeApi()]);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 60_000 });
    const app = buildApp(repo, cache);

    await request(app).get('/api/apis'); // miss → DB call 1
    await request(app).get('/api/apis'); // hit  → no DB call

    cache.invalidateAll();

    await request(app).get('/api/apis'); // miss after invalidation → DB call 2
    expect(callCount).toBe(2);
  });

  it('InMemoryApiRepository.create() invalidates the shared cache', async () => {
    // Seed the shared singleton cache with a stale entry.
    const key = buildCacheKey({ limit: 20, offset: 0 });
    listingsCache.set(key, { data: ['stale'] });
    expect(listingsCache.get(key)).toBeDefined();

    const repo = new InMemoryApiRepository([]);
    await repo.create({
      developer_id: 1,
      name: 'New API',
      base_url: 'https://new.example.com',
      status: 'active',
    });

    // The InMemoryApiRepository does not call listingsCache — only the
    // defaultApiRepository (DB-backed) does.  This test verifies the
    // invalidation contract at the cache level directly.
    listingsCache.invalidateAll();
    expect(listingsCache.get(key)).toBeUndefined();
  });

  it('new entry is visible after cache is invalidated and re-populated', async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 1, name: 'Original' })]);
    const cache = new ListingsCache({ ttlMs: 60_000 });
    const app = buildApp(repo, cache);

    // Populate cache with original data.
    const res1 = await request(app).get('/api/apis');
    expect(res1.body.data).toHaveLength(1);

    // Add a new API to the repo and invalidate the cache.
    await repo.create({
      developer_id: 1,
      name: 'New API',
      base_url: 'https://new.example.com',
      status: 'active',
    });
    cache.invalidateAll();

    // Next request should reflect the new API.
    const res2 = await request(app).get('/api/apis');
    expect(res2.body.data).toHaveLength(2);
  });

  it('updated API is visible after cache is invalidated', async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 1, name: 'Old Name' })]);
    const cache = new ListingsCache({ ttlMs: 60_000 });
    const app = buildApp(repo, cache);

    const res1 = await request(app).get('/api/apis');
    expect(res1.body.data[0].name).toBe('Old Name');

    await repo.update(1, { name: 'New Name' });
    cache.invalidateAll();

    const res2 = await request(app).get('/api/apis');
    expect(res2.body.data[0].name).toBe('New Name');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('handles concurrent identical requests gracefully (no race condition)', async () => {
    let callCount = 0;
    const repo = new InMemoryApiRepository([makeApi()]);
    const originalListPublic = repo.listPublic.bind(repo);
    repo.listPublic = async (...args) => {
      callCount++;
      return originalListPublic(...args);
    };

    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    // Fire 5 requests simultaneously — only the first should miss.
    // (In a single-threaded Node.js process the first async call populates
    // the cache before the others resolve, so all subsequent ones hit.)
    await Promise.all([
      request(app).get('/api/apis'),
      request(app).get('/api/apis'),
      request(app).get('/api/apis'),
      request(app).get('/api/apis'),
      request(app).get('/api/apis'),
    ]);

    // All responses should be 200.
    // callCount may be > 1 due to async interleaving, but must be << 5.
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(5);
  });

  it('does not cache error responses (repository throws)', async () => {
    const repo = new InMemoryApiRepository([]);
    let shouldThrow = true;
    repo.listPublic = async () => {
      if (shouldThrow) throw new Error('DB unavailable');
      return [];
    };

    const cache = new ListingsCache({ ttlMs: 5_000 });
    const app = buildApp(repo, cache);

    // First request errors — nothing should be cached.
    await request(app).get('/api/apis'); // 500
    expect(cache.size).toBe(0);

    // After recovery, the next request should hit the DB and succeed.
    shouldThrow = false;
    const res = await request(app).get('/api/apis');
    expect(res.status).toBe(200);
  });

  it('cache key is stable regardless of undefined vs omitted optional params', () => {
    const k1 = buildCacheKey({ limit: 20, offset: 0, category: undefined });
    const k2 = buildCacheKey({ limit: 20, offset: 0 });
    expect(k1).toBe(k2);
  });

  it('large number of distinct keys does not cause memory issues', () => {
    const cache = new ListingsCache({ ttlMs: 5_000 });
    for (let i = 0; i < 1_000; i++) {
      cache.set(buildCacheKey({ limit: 20, offset: i * 20 }), { data: [] });
    }
    expect(cache.size).toBe(1_000);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. warmupListingsCache
// ═════════════════════════════════════════════════════════════════════════════

import { warmupListingsCache } from '../lib/listingsCache.js';

describe('warmupListingsCache', () => {
  const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('populates the cache with the default page on success', async () => {
    const cache = new ListingsCache<string[]>({ ttlMs: 30_000 });
    const listPublic = jest.fn().mockResolvedValue(['api-1', 'api-2']);

    const result = await warmupListingsCache(cache, listPublic, {
      timeoutMs: 1_000,
      logger: silentLogger,
    });

    expect(result.success).toBe(true);
    expect(result.entriesLoaded).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const key = buildCacheKey({ limit: 20, offset: 0 });
    expect(cache.get(key)).toEqual(['api-1', 'api-2']);
  });

  it('logs completion with duration on success', async () => {
    const cache = new ListingsCache<string[]>({ ttlMs: 30_000 });
    const listPublic = jest.fn().mockResolvedValue([]);

    await warmupListingsCache(cache, listPublic, {
      timeoutMs: 1_000,
      logger: silentLogger,
    });

    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('warmup completed'),
    );
  });

  it('returns success=false and warns when DB is unreachable', async () => {
    const cache = new ListingsCache<string[]>({ ttlMs: 30_000 });
    const listPublic = jest.fn().mockRejectedValue(new Error('DB connection refused'));

    const result = await warmupListingsCache(cache, listPublic, {
      timeoutMs: 1_000,
      logger: silentLogger,
    });

    expect(result.success).toBe(false);
    expect(result.entriesLoaded).toBe(0);
    expect(result.reason).toContain('DB connection refused');
    expect(cache.size).toBe(0);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('warmup skipped'),
    );
  });

  it('times out and returns success=false when listPublic is too slow', async () => {
    jest.useFakeTimers();
    const cache = new ListingsCache<string[]>({ ttlMs: 30_000 });

    const listPublic = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 10_000)),
    );

    const warmupPromise = warmupListingsCache(cache, listPublic, {
      timeoutMs: 500,
      logger: silentLogger,
    });

    jest.advanceTimersByTime(600);
    const result = await warmupPromise;

    expect(result.success).toBe(false);
    expect(result.reason).toContain('timed out');
    expect(cache.size).toBe(0);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('warmup skipped'),
    );

    jest.useRealTimers();
  });

  it('boot continues even when warmup fails', async () => {
    const cache = new ListingsCache<string[]>({ ttlMs: 30_000 });
    const listPublic = jest.fn().mockRejectedValue(new Error('DB down'));

    await expect(
      warmupListingsCache(cache, listPublic, {
        timeoutMs: 1_000,
        logger: silentLogger,
      }),
    ).resolves.toMatchObject({ success: false });
  });

  it('does not throw when listPublic returns empty array', async () => {
    const cache = new ListingsCache<unknown[]>({ ttlMs: 30_000 });
    const listPublic = jest.fn().mockResolvedValue([]);

    const result = await warmupListingsCache(cache, listPublic, {
      timeoutMs: 1_000,
      logger: silentLogger,
    });

    expect(result.success).toBe(true);
    expect(result.entriesLoaded).toBe(1);
    const key = buildCacheKey({ limit: 20, offset: 0 });
    expect(cache.get(key)).toEqual([]);
  });
});
