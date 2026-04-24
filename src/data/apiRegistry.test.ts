import assert from 'node:assert/strict';

import { InMemoryApiRegistry, resolveEndpointPrice } from './apiRegistry.js';
import type { ApiRegistryEntry, EndpointPricing } from '../types/gateway.js';

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
