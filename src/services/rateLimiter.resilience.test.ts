import assert from 'node:assert/strict';
import type { RateLimitResult } from '../types/gateway.js';
import {
  InMemoryRateLimiterStore,
  ResilientRateLimiterStore,
  type RateLimiterStore,
  type RateLimiterStoreCheckOptions,
} from './rateLimiter.js';

class ToggleStore implements RateLimiterStore {
  failing = false;
  calls = 0;
  readonly results: RateLimitResult[] = [];

  async check(_bucketKey: string, _options: RateLimiterStoreCheckOptions): Promise<RateLimitResult> {
    this.calls += 1;
    if (this.failing) {
      throw new Error('distributed store unavailable');
    }
    const result = this.results.shift() ?? { allowed: true };
    return result;
  }
}

function options(overrides: Partial<RateLimiterStoreCheckOptions> = {}): RateLimiterStoreCheckOptions {
  return {
    maxRequests: 100,
    windowMs: 60_000,
    now: 1_000,
    ...overrides,
  };
}

describe('ResilientRateLimiterStore', () => {
  it('fails closed by default when the distributed store is unavailable', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary);

    const result = await store.check('protected-key', options({ windowMs: 5_000 }));

    assert.deepEqual(result, { allowed: false, retryAfterMs: 5_000 });
    assert.equal(store.isDegraded(), true);
    assert.equal(primary.calls, 1);
  });

  it('does not call the local fallback in fail-closed mode', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fail-closed',
      fallbackMaxRequests: 1,
    });

    const first = await store.check('same-key', options({ maxRequests: 1 }));
    const second = await store.check('same-key', options({ maxRequests: 1 }));

    assert.equal(first.allowed, false);
    assert.equal(second.allowed, false);
    assert.equal(first.retryAfterMs, 60_000);
    assert.equal(primary.calls, 2);
  });

  it('uses a bounded local policy during an explicitly configured outage', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 2,
      fallbackWindowMs: 2_000,
      maxFallbackBuckets: 100,
    });

    assert.deepEqual(await store.check('burst-key', options({ maxRequests: 100 })), { allowed: true });
    assert.deepEqual(await store.check('burst-key', options({ maxRequests: 100, now: 1_500 })), { allowed: true });

    const blocked = await store.check('burst-key', options({ maxRequests: 100, now: 1_750 }));
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 1_250);
  });

  it('caps fallback requests and window independently of the distributed policy', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 1,
      fallbackWindowMs: 1_000,
    });

    const first = await store.check('capped-key', options({ maxRequests: 500, windowMs: 60_000 }));
    const blocked = await store.check('capped-key', options({ maxRequests: 500, windowMs: 60_000, now: 1_500 }));

    assert.equal(first.allowed, true);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 500);
  });

  it('evicts the oldest fallback key at the configured hard bound', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 1,
      maxFallbackBuckets: 2,
    });

    await store.check('oldest', options());
    await store.check('middle', options());
    await store.check('newest', options());

    const oldestAfterEviction = await store.check('oldest', options({ now: 2_000 }));
    assert.equal(oldestAfterEviction.allowed, true);
  });

  it('returns to the primary store and clears local counters after recovery', async () => {
    const primary = new ToggleStore();
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 1,
      fallbackWindowMs: 60_000,
    });

    primary.failing = true;
    await store.check('recovery-key', options());
    const duringOutage = await store.check('recovery-key', options({ now: 2_000 }));
    assert.equal(duringOutage.allowed, false);

    primary.failing = false;
    primary.results.push({ allowed: true });
    const recovered = await store.check('recovery-key', options({ now: 3_000 }));
    assert.deepEqual(recovered, { allowed: true });
    assert.equal(store.isDegraded(), false);

    primary.failing = true;
    const freshFallback = await store.check('recovery-key', options({ now: 4_000 }));
    assert.deepEqual(freshFallback, { allowed: true });
  });

  it('does not merge fallback counters into a recovered distributed bucket', async () => {
    const primary = new ToggleStore();
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 1,
    });

    primary.failing = true;
    await store.check('no-merge', options());

    primary.failing = false;
    primary.results.push({ allowed: false, retryAfterMs: 9_000 });
    const distributedDecision = await store.check('no-merge', options());

    assert.deepEqual(distributedDecision, { allowed: false, retryAfterMs: 9_000 });
    assert.equal(primary.calls, 2);
  });

  it('re-enters fallback mode if the store fails again after recovery', async () => {
    const primary = new ToggleStore();
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 1,
    });

    primary.failing = true;
    await store.check('flapping-key', options());
    primary.failing = false;
    primary.results.push({ allowed: true });
    await store.check('flapping-key', options());
    primary.failing = true;

    const firstAfterFlap = await store.check('flapping-key', options());
    assert.deepEqual(firstAfterFlap, { allowed: true });
    const secondAfterFlap = await store.check('flapping-key', options());
    assert.equal(secondAfterFlap.allowed, false);
  });

  it('rejects unsafe fallback dimensions before accepting traffic', () => {
    const primary = new InMemoryRateLimiterStore();

    assert.throws(
      () => new ResilientRateLimiterStore(primary, { fallbackMaxRequests: 0 }),
      /fallbackMaxRequests must be a positive integer/,
    );
    assert.throws(
      () => new ResilientRateLimiterStore(primary, { fallbackWindowMs: -1 }),
      /fallbackWindowMs must be a positive integer/,
    );
    assert.throws(
      () => new ResilientRateLimiterStore(primary, { maxFallbackBuckets: 0 }),
      /maxBuckets must be a positive integer/,
    );
  });

  it('isolates fallback buckets by the complete distributed bucket key', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 1,
    });

    const userA = await store.check('tenant-a:user-1', options());
    const userB = await store.check('tenant-b:user-1', options());
    const userASecond = await store.check('tenant-a:user-1', options());

    assert.equal(userA.allowed, true);
    assert.equal(userB.allowed, true);
    assert.equal(userASecond.allowed, false);
  });

  it('keeps fail-closed retry hints bounded to a usable positive duration', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, { outageMode: 'fail-closed' });

    const result = await store.check('bounded-retry', options({ windowMs: 1 }));

    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterMs, 1_000);
  });

  it('enforces the fallback ceiling under a concurrent burst', async () => {
    const primary = new ToggleStore();
    primary.failing = true;
    const store = new ResilientRateLimiterStore(primary, {
      outageMode: 'fallback',
      fallbackMaxRequests: 3,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.check('concurrent-burst', options())),
    );

    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.equal(results.filter((result) => !result.allowed).length, 7);
  });

  it('does not expose primary store error details to callers', async () => {
    const primary: RateLimiterStore = {
      async check() {
        throw new Error('postgres://admin:password@internal/db');
      },
    };
    const store = new ResilientRateLimiterStore(primary, { outageMode: 'fail-closed' });

    const result = await store.check('safe-error', options());

    assert.deepEqual(result, { allowed: false, retryAfterMs: 60_000 });
    assert.equal(JSON.stringify(result).includes('password'), false);
  });

  it('does not reset healthy primary state when local fallback is empty', async () => {
    const primary = new ToggleStore();
    const store = new ResilientRateLimiterStore(primary, { outageMode: 'fallback' });

    primary.results.push({ allowed: false, retryAfterMs: 321 });
    const result = await store.check('primary-decision', options());

    assert.deepEqual(result, { allowed: false, retryAfterMs: 321 });
    assert.equal(store.isDegraded(), false);
  });

  it('records outage and recovery metrics for operational dashboards', async () => {
    const primary = new ToggleStore();
    const store = new ResilientRateLimiterStore(primary, { outageMode: 'fallback' });
    primary.failing = true;
    await store.check('metric-key', options());

    const degradedMetrics = await import('../metrics.js');
    const outageMetric = (await degradedMetrics.register.getMetricsAsJSON()).find(
      (metric: { name: string }) => metric.name === 'rate_limiter_store_outages_total',
    ) as { values?: Array<{ labels: Record<string, string>; value: number }> } | undefined;
    assert.ok(outageMetric?.values?.some(
      (entry) => entry.labels.outage_mode === 'fallback' && entry.value >= 1,
    ));

    primary.failing = false;
    await store.check('metric-key', options());
    const stateMetric = (await degradedMetrics.register.getMetricsAsJSON()).find(
      (metric: { name: string }) => metric.name === 'rate_limiter_store_degraded',
    ) as { values?: Array<{ value: number }> } | undefined;
    assert.equal(stateMetric?.values?.[0]?.value, 0);
  });
});

describe('InMemoryRateLimiterStore capacity guard', () => {
  it('rejects a zero capacity guard instead of allowing unbounded storage', () => {
    assert.throws(() => new InMemoryRateLimiterStore(0), /maxBuckets must be a positive integer/);
  });

  it('retains normal store behavior with its default capacity', async () => {
    const store = new InMemoryRateLimiterStore();
    const first = await store.check('default-capacity', options({ maxRequests: 1 }));
    const second = await store.check('default-capacity', options({ maxRequests: 1 }));

    assert.deepEqual(first, { allowed: true });
    assert.equal(second.allowed, false);
  });
});
