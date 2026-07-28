import assert from 'node:assert/strict';

import { InMemoryApiRegistry, resolveEndpointPrice } from './apiRegistry.js';
import type { ApiRegistryEntry, EndpointPricing } from '../types/gateway.js';
import { encodeCursor } from '../lib/cursorPagination.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ENTRY_A: ApiRegistryEntry = {
  id: 'api_100',
  slug: 'test-api',
  base_url: 'http://localhost:5000',
  developerId: 'dev_100',
  endpoints: [
    { endpointId: 'ep_1', path: '/data', priceUsdc: 0.02 },
    { endpointId: 'ep_2', path: '/data/advanced', priceUsdc: 0.10 },
    { endpointId: 'ep_wild', path: '*', priceUsdc: 0.005 },
  ],
};

const ENTRY_B: ApiRegistryEntry = {
  id: 'api_200',
  slug: 'other-api',
  base_url: 'http://localhost:5001',
  developerId: 'dev_200',
  endpoints: [
    { endpointId: 'ep_3', path: '/translate', priceUsdc: 0.03 },
  ],
};

// ── InMemoryApiRegistry ─────────────────────────────────────────────────────

describe('InMemoryApiRegistry', () => {
  test('resolve by id returns the correct entry', () => {
    const registry = new InMemoryApiRegistry([ENTRY_A, ENTRY_B]);

    const result = registry.resolve('api_100');

    assert.deepStrictEqual(result, ENTRY_A);
  });

  test('resolve by slug returns the correct entry', () => {
    const registry = new InMemoryApiRegistry([ENTRY_A]);

    const result = registry.resolve('test-api');

    assert.deepStrictEqual(result, ENTRY_A);
  });

  test('resolve returns undefined for unknown slug or id', () => {
    const registry = new InMemoryApiRegistry([ENTRY_A]);

    assert.equal(registry.resolve('unknown-slug'), undefined);
    assert.equal(registry.resolve('api_999'), undefined);
  });

  test('resolve returns undefined when registry is empty', () => {
    const registry = new InMemoryApiRegistry();

    assert.equal(registry.resolve('anything'), undefined);
  });

  test('register adds an entry resolvable by both id and slug', () => {
    const registry = new InMemoryApiRegistry();

    registry.register(ENTRY_B);

    assert.deepStrictEqual(registry.resolve('api_200'), ENTRY_B);
    assert.deepStrictEqual(registry.resolve('other-api'), ENTRY_B);
  });

  test('register overwrites an existing entry with the same id', () => {
    const registry = new InMemoryApiRegistry([ENTRY_A]);
    const updated: ApiRegistryEntry = { ...ENTRY_A, base_url: 'http://updated:9000' };

    registry.register(updated);

    assert.equal(registry.resolve('api_100')!.base_url, 'http://updated:9000');
  });

  test('constructor seeds resolve identical entries as register', () => {
    const fromCtor = new InMemoryApiRegistry([ENTRY_A, ENTRY_B]);
    const fromRegister = new InMemoryApiRegistry();
    fromRegister.register(ENTRY_A);
    fromRegister.register(ENTRY_B);

    assert.deepStrictEqual(fromCtor.resolve('api_100'), fromRegister.resolve('api_100'));
    assert.deepStrictEqual(fromCtor.resolve('api_200'), fromRegister.resolve('api_200'));
  });

  test('register rejects non-http upstream URLs', () => {
    const registry = new InMemoryApiRegistry();

    assert.throws(
      () => registry.register({ ...ENTRY_A, base_url: 'ftp://example.com/data' }),
      /base_url must use http or https/i,
    );
  });

  test('register rejects private IP literals that are not explicitly allowlisted', () => {
    const registry = new InMemoryApiRegistry();

    assert.throws(
      () => registry.register({ ...ENTRY_A, base_url: 'http://169.254.169.254/latest' }),
      /private or loopback IP range/i,
    );
  });
});

// ── Cursor pagination (list) ────────────────────────────────────────────────

describe('InMemoryApiRegistry.list (cursor pagination)', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  const mkEntry = (
    id: string,
    slug: string,
    created_at: Date,
  ): ApiRegistryEntry => ({
    id,
    slug,
    base_url: `http://localhost:${id.split('_')[1] ?? 8000}`,
    developerId: 'dev_test',
    endpoints: [{ endpointId: 'ep', path: '*', priceUsdc: 0.01 }],
    created_at,
  });

  test('returns all entries when no cursor is provided', () => {
    const entries = [
      mkEntry('api_1', 'slug-1', new Date(now.getTime() - 3000)),
      mkEntry('api_2', 'slug-2', new Date(now.getTime() - 2000)),
      mkEntry('api_3', 'slug-3', new Date(now.getTime() - 1000)),
    ];
    const registry = new InMemoryApiRegistry(entries);

    const result = registry.list(null, 10);

    assert.equal(result.entries.length, 3);
    // Sorted by created_at DESC, so most recent first
    assert.equal(result.entries[0].id, 'api_3');
    assert.equal(result.entries[1].id, 'api_2');
    assert.equal(result.entries[2].id, 'api_1');
    assert.equal(result.nextCursor, null);
  });

  test('returns a nextCursor when there are more entries than the limit', () => {
    const entries = [
      mkEntry('api_1', 'slug-1', new Date(now.getTime() - 3000)),
      mkEntry('api_2', 'slug-2', new Date(now.getTime() - 2000)),
      mkEntry('api_3', 'slug-3', new Date(now.getTime() - 1000)),
      mkEntry('api_4', 'slug-4', now),
    ];
    const registry = new InMemoryApiRegistry(entries);

    const result = registry.list(null, 2);

    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].id, 'api_4');
    assert.equal(result.entries[1].id, 'api_3');
    assert.notEqual(result.nextCursor, null);
    assert.ok(typeof result.nextCursor === 'string');
  });

  test('correctly pages through results using a cursor', () => {
    const entries = [
      mkEntry('api_1', 'slug-1', new Date(now.getTime() - 3000)),
      mkEntry('api_2', 'slug-2', new Date(now.getTime() - 2000)),
      mkEntry('api_3', 'slug-3', new Date(now.getTime() - 1000)),
      mkEntry('api_4', 'slug-4', now),
    ];
    const registry = new InMemoryApiRegistry(entries);

    // Page 1: most recent 2 entries
    const page1 = registry.list(null, 2);
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.entries[0].id, 'api_4');
    assert.equal(page1.entries[1].id, 'api_3');
    assert.notEqual(page1.nextCursor, null);

    // Page 2: resume from cursor
    const page2 = registry.list(page1.nextCursor, 2);
    assert.equal(page2.entries.length, 2);
    assert.equal(page2.entries[0].id, 'api_2');
    assert.equal(page2.entries[1].id, 'api_1');
    assert.equal(page2.nextCursor, null);
  });

  test('handles entries without created_at (stable by id)', () => {
    const e1: ApiRegistryEntry = {
      id: 'api_z', slug: 'slug-z', base_url: 'http://localhost:9001',
      developerId: 'dev_test', endpoints: [],
    };
    const e2: ApiRegistryEntry = {
      id: 'api_a', slug: 'slug-a', base_url: 'http://localhost:9002',
      developerId: 'dev_test', endpoints: [],
    };
    const registry = new InMemoryApiRegistry([e1, e2]);

    const result = registry.list(null, 10);

    assert.equal(result.entries.length, 2);
    // Same created_at (both 0), so sorted by id DESC
    assert.equal(result.entries[0].id, 'api_z');
    assert.equal(result.entries[1].id, 'api_a');
  });

  test('returns empty list when registry is empty', () => {
    const registry = new InMemoryApiRegistry();

    const result = registry.list(null, 10);

    assert.equal(result.entries.length, 0);
    assert.equal(result.nextCursor, null);
  });

  test('clamps limit to available entries', () => {
    const entries = [mkEntry('api_1', 'slug-1', now)];
    const registry = new InMemoryApiRegistry(entries);

    const result = registry.list(null, 50);

    assert.equal(result.entries.length, 1);
    assert.equal(result.nextCursor, null);
  });
});

// ── resolveEndpointPrice ────────────────────────────────────────────────────

describe('resolveEndpointPrice', () => {
  const endpoints: EndpointPricing[] = ENTRY_A.endpoints;

  test('returns exact match for a known path', () => {
    const result = resolveEndpointPrice(endpoints, '/data');

    assert.equal(result.endpointId, 'ep_1');
    assert.equal(result.priceUsdc, 0.02);
  });

  test('returns longest prefix match', () => {
    const result = resolveEndpointPrice(endpoints, '/data/advanced/extra');

    assert.equal(result.endpointId, 'ep_2');
    assert.equal(result.priceUsdc, 0.10);
  });

  test('falls back to wildcard when no prefix matches', () => {
    const result = resolveEndpointPrice(endpoints, '/unknown/path');

    assert.equal(result.endpointId, 'ep_wild');
    assert.equal(result.priceUsdc, 0.005);
  });

  test('returns default free pricing when no match and no wildcard', () => {
    const noWildcard: EndpointPricing[] = [
      { endpointId: 'ep_only', path: '/specific', priceUsdc: 1.0 },
    ];

    const result = resolveEndpointPrice(noWildcard, '/other');

    assert.equal(result.endpointId, 'default');
    assert.equal(result.path, '*');
    assert.equal(result.priceUsdc, 0);
  });

  test('handles path without leading slash', () => {
    const result = resolveEndpointPrice(endpoints, 'data');

    assert.equal(result.endpointId, 'ep_1');
  });

  test('returns default free pricing for empty endpoints array', () => {
    const result = resolveEndpointPrice([], '/anything');

    assert.equal(result.endpointId, 'default');
    assert.equal(result.priceUsdc, 0);
  });
});
