import assert from 'node:assert/strict';

import {
  createConfiguredRateLimiter,
  createRateLimiter,
  InMemoryRateLimiter,
  InMemoryRateLimiterStore,
  isPersistentRateLimiterStore,
  type PersistentRateLimiterPool,
  PostgresRateLimiterStore,
  resolveRateLimiterConfig,
} from './rateLimiter.js';

type StoredBucket = {
  bucket_key: string;
  last_refill_ms: number;
  tokens: number;
  updated_at: number;
};

class MockPersistentPool implements PersistentRateLimiterPool {
  readonly createdTables = new Set<string>();
  readonly rows = new Map<string, StoredBucket>();

  private readonly lockOwners = new Map<string, number>();
  private readonly lockQueues = new Map<string, Array<() => void>>();
  private nextClientId = 1;

  async connect() {
    const clientId = this.nextClientId++;
    let lockedKey: string | null = null;

    return {
      query: async <T = unknown>(text: string, params: unknown[] = []) => {
        const normalized = text.replace(/\s+/g, ' ').trim();

        if (normalized.startsWith('BEGIN')) {
          return { rows: [] as T[] };
        }

        if (normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
          this.releaseLock(clientId, lockedKey);
          lockedKey = null;
          return { rows: [] as T[] };
        }

        if (normalized.startsWith('CREATE TABLE IF NOT EXISTS')) {
          const match = normalized.match(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/i);
          if (match?.[1]) {
            this.createdTables.add(match[1]);
          }
          return { rows: [] as T[] };
        }

        if (normalized.startsWith('CREATE INDEX IF NOT EXISTS')) {
          return { rows: [] as T[] };
        }

        if (normalized.startsWith('INSERT INTO')) {
          const bucketKey = String(params[0]);
          if (!this.rows.has(bucketKey)) {
            this.rows.set(bucketKey, {
              bucket_key: bucketKey,
              last_refill_ms: Number(params[2]),
              tokens: Number(params[1]),
              updated_at: Date.now(),
            });
          }
          return { rows: [] as T[] };
        }

        if (normalized.includes('FOR UPDATE')) {
          const bucketKey = String(params[0]);
          await this.acquireLock(bucketKey, clientId);
          lockedKey = bucketKey;

          const row = this.rows.get(bucketKey);
          return {
            rows: row ? [row as unknown as T] : [],
          };
        }

        if (normalized.startsWith('UPDATE')) {
          const bucketKey = String(params[0]);
          const row = this.rows.get(bucketKey);

          if (!row) {
            throw new Error(`Missing row for ${bucketKey}`);
          }

          row.tokens = Number(params[1]);
          row.last_refill_ms = Number(params[2]);
          row.updated_at = Date.now();
          return { rows: [] as T[] };
        }

        if (normalized.startsWith('SELECT bucket_key, tokens FROM')) {
          const bucketKey = String(params[0]);
          const row = this.rows.get(bucketKey);

          return {
            rows: row ? ([{ bucket_key: row.bucket_key, tokens: row.tokens }] as T[]) : [],
          };
        }

        throw new Error(`Unhandled SQL in mock pool: ${normalized}`);
      },
      release: () => {
        this.releaseLock(clientId, lockedKey);
        lockedKey = null;
      },
    };
  }

  private async acquireLock(bucketKey: string, clientId: number): Promise<void> {
    while (true) {
      const owner = this.lockOwners.get(bucketKey);

      if (owner === undefined || owner === clientId) {
        this.lockOwners.set(bucketKey, clientId);
        return;
      }

      await new Promise<void>((resolve) => {
        const queue = this.lockQueues.get(bucketKey) ?? [];
        queue.push(resolve);
        this.lockQueues.set(bucketKey, queue);
      });
    }
  }

  private releaseLock(clientId: number, bucketKey: string | null): void {
    if (!bucketKey) {
      return;
    }

    if (this.lockOwners.get(bucketKey) !== clientId) {
      return;
    }

    this.lockOwners.delete(bucketKey);
    const queue = this.lockQueues.get(bucketKey);
    const next = queue?.shift();

    if (!queue || queue.length === 0) {
      this.lockQueues.delete(bucketKey);
    }

    next?.();
  }
}

describe('InMemoryRateLimiter', () => {
  let now = 0;

  beforeEach(() => {
    now = new Date('2026-03-30T00:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('allows up to maxRequests then rejects until the window elapses', async () => {
    const rl = createRateLimiter(2, 1000);
    const apiKey = 'test-key';

    assert.deepEqual(await rl.check(apiKey), { allowed: true });
    assert.deepEqual(await rl.check(apiKey), { allowed: true });

    const rejected = await rl.check(apiKey);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfterMs, 1000);

    now += 500;
    const retrying = await rl.check(apiKey);
    assert.equal(retrying.allowed, false);
    assert.equal(retrying.retryAfterMs, 500);

    now += 500;
    assert.deepEqual(await rl.check(apiKey), { allowed: true });
  });

  test('tracks buckets independently per API key', async () => {
    const rl = createRateLimiter(1, 1_000);

    assert.deepEqual(await rl.check('first-key'), { allowed: true });
    assert.deepEqual(await rl.check('second-key'), { allowed: true });

    const firstRejected = await rl.check('first-key');
    assert.equal(firstRejected.allowed, false);
    assert.equal(firstRejected.retryAfterMs, 1000);
  });

  test('exhaust helper forces the next request to be rejected', async () => {
    const rl = createRateLimiter(3, 5_000);

    rl.exhaust('force-blocked');

    const result = await rl.check('force-blocked');
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterMs, 5000);
  });

  test('reset helper clears all in-memory buckets', async () => {
    const rl = createRateLimiter(1, 1_000);

    await rl.check('reset-me');
    rl.reset();

    assert.deepEqual(await rl.check('reset-me'), { allowed: true });
  });

  test('rejects invalid limiter dimensions', () => {
    assert.throws(() => createRateLimiter(0, 1_000), /maxRequests must be a positive integer/);
    assert.throws(() => createRateLimiter(1, 0), /windowMs must be a positive integer/);
  });
});

describe('InMemoryRateLimiterStore', () => {
  test('persists the updated bucket state between checks', async () => {
    const store = new InMemoryRateLimiterStore();
    const options = { maxRequests: 2, now: 10, windowMs: 1000 };

    assert.deepEqual(await store.check('bucket', options), { allowed: true });
    assert.deepEqual(await store.check('bucket', options), { allowed: true });

    const blocked = await store.check('bucket', options);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 1000);
  });
});

describe('PostgresRateLimiterStore', () => {
  let now = 0;

  beforeEach(() => {
    now = new Date('2026-03-30T00:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('shares buckets across limiter instances backed by the same pool', async () => {
    const pool = new MockPersistentPool();
    const limiterA = createConfiguredRateLimiter(
      { maxRequests: 2, store: 'postgres', windowMs: 1000 },
      pool,
    );
    const limiterB = createConfiguredRateLimiter(
      { maxRequests: 2, store: 'postgres', windowMs: 1000 },
      pool,
    );

    assert.deepEqual(await limiterA.check('shared-key'), { allowed: true });
    assert.deepEqual(await limiterB.check('shared-key'), { allowed: true });

    const blocked = await limiterA.check('shared-key');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 1000);

    assert.deepEqual(pool.rows.get('shared-key'), {
      bucket_key: 'shared-key',
      last_refill_ms: now,
      tokens: 0,
      updated_at: now,
    });
  });

  test('refills exhausted buckets after the window elapses', async () => {
    const pool = new MockPersistentPool();
    const limiter = createConfiguredRateLimiter(
      { maxRequests: 1, store: 'postgres', windowMs: 1_000 },
      pool,
    );

    assert.deepEqual(await limiter.check('refill-key'), { allowed: true });

    const blocked = await limiter.check('refill-key');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 1_000);

    now += 1_000;
    assert.deepEqual(await limiter.check('refill-key'), { allowed: true });
  });

  test('serializes concurrent checks so only maxRequests calls succeed', async () => {
    const pool = new MockPersistentPool();
    const limiter = createConfiguredRateLimiter(
      { maxRequests: 2, store: 'postgres', windowMs: 60_000 },
      pool,
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => limiter.check('concurrent-key')),
    );

    assert.equal(results.filter((result) => result.allowed).length, 2);
    assert.equal(results.filter((result) => !result.allowed).length, 3);
    for (const rejected of results.filter((result) => !result.allowed)) {
      assert.equal(rejected.retryAfterMs, 60_000);
    }
  });

  test('creates the backing table lazily on first use', async () => {
    const pool = new MockPersistentPool();
    const store = new PostgresRateLimiterStore(pool, {
      tableName: 'custom_rate_limit_table',
    });

    assert.deepEqual(
      await store.check('lazy-table-key', {
        maxRequests: 1,
        now: Date.now(),
        windowMs: 1_000,
      }),
      { allowed: true },
    );

    assert.ok(pool.createdTables.has('custom_rate_limit_table'));
  });

  test('rejects unsafe table names before querying the database', () => {
    const pool = new MockPersistentPool();

    assert.throws(
      () => new PostgresRateLimiterStore(pool, { tableName: 'rate-limits;DROP TABLE users' }),
      /letters, numbers, and underscores/,
    );
  });

  test('rejects malformed persisted string values', async () => {
    const pool: PersistentRateLimiterPool = {
      async connect() {
        return {
          async query<T = unknown>(text: string) {
            if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
              return { rows: [] as T[] };
            }
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
              return { rows: [] as T[] };
            }
            if (text.includes('INSERT INTO')) {
              return { rows: [] as T[] };
            }
            if (text.includes('FOR UPDATE')) {
              return {
                rows: [
                  {
                    bucket_key: 'bad-string',
                    tokens: '1.5',
                    last_refill_ms: '123',
                  },
                ] as T[],
              };
            }
            return { rows: [] as T[] };
          },
          release() {},
        };
      },
    };

    const store = new PostgresRateLimiterStore(pool);

    await assert.rejects(
      store.check('bad-string', { maxRequests: 2, now, windowMs: 1_000 }),
      /tokens must be stored as a non-negative integer/,
    );
  });

  test('rejects malformed persisted numeric values', async () => {
    const pool: PersistentRateLimiterPool = {
      async connect() {
        return {
          async query<T = unknown>(text: string) {
            if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
              return { rows: [] as T[] };
            }
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
              return { rows: [] as T[] };
            }
            if (text.includes('INSERT INTO')) {
              return { rows: [] as T[] };
            }
            if (text.includes('FOR UPDATE')) {
              return {
                rows: [
                  {
                    bucket_key: 'bad-number',
                    tokens: -1,
                    last_refill_ms: 123,
                  },
                ] as T[],
              };
            }
            return { rows: [] as T[] };
          },
          release() {},
        };
      },
    };

    const store = new PostgresRateLimiterStore(pool);

    await assert.rejects(
      store.check('bad-number', { maxRequests: 2, now, windowMs: 1_000 }),
      /tokens must be stored as a non-negative integer/,
    );
  });

  test('accepts persisted integer strings from the backing store', async () => {
    const pool: PersistentRateLimiterPool = {
      async connect() {
        return {
          async query<T = unknown>(text: string) {
            if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
              return { rows: [] as T[] };
            }
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
              return { rows: [] as T[] };
            }
            if (text.includes('INSERT INTO') || text.trim().startsWith('UPDATE')) {
              return { rows: [] as T[] };
            }
            if (text.includes('FOR UPDATE')) {
              return {
                rows: [
                  {
                    bucket_key: 'string-values',
                    tokens: '2',
                    last_refill_ms: String(now),
                  },
                ] as T[],
              };
            }
            return { rows: [] as T[] };
          },
          release() {},
        };
      },
    };

    const store = new PostgresRateLimiterStore(pool);

    assert.deepEqual(
      await store.check('string-values', { maxRequests: 2, now, windowMs: 1_000 }),
      { allowed: true },
    );
  });

  test('rolls back the transaction when a database write fails', async () => {
    let rollbackCount = 0;
    const pool: PersistentRateLimiterPool = {
      async connect() {
        return {
          async query<T = unknown>(text: string) {
            if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
              return { rows: [] as T[] };
            }
            if (text === 'BEGIN') {
              return { rows: [] as T[] };
            }
            if (text === 'ROLLBACK') {
              rollbackCount += 1;
              return { rows: [] as T[] };
            }
            if (text.includes('INSERT INTO')) {
              return { rows: [] as T[] };
            }
            if (text.includes('FOR UPDATE')) {
              return {
                rows: [
                  {
                    bucket_key: 'rollback-key',
                    tokens: 2,
                    last_refill_ms: now,
                  },
                ] as T[],
              };
            }
            if (text.includes('UPDATE')) {
              throw new Error('update failed');
            }
            return { rows: [] as T[] };
          },
          release() {},
        };
      },
    };

    const store = new PostgresRateLimiterStore(pool);

    await assert.rejects(
      store.check('rollback-key', { maxRequests: 2, now, windowMs: 1_000 }),
      /update failed/,
    );
    assert.equal(rollbackCount, 1);
  });

  test('throws if a bucket still cannot be read after initialization', async () => {
    const pool: PersistentRateLimiterPool = {
      async connect() {
        return {
          async query<T = unknown>(text: string) {
            if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
              return { rows: [] as T[] };
            }
            return { rows: [] as T[] };
          },
          release() {},
        };
      },
    };

    const store = new PostgresRateLimiterStore(pool);

    await assert.rejects(
      store.check('missing-row', { maxRequests: 2, now, windowMs: 1_000 }),
      /was not found after initialization/,
    );
  });

  test('retries table creation after an initialization failure', async () => {
    let failCreate = true;
    const pool = new MockPersistentPool();
    const originalConnect = pool.connect.bind(pool);

    pool.connect = async () => {
      const client = await originalConnect();
      return {
        async query<T = unknown>(text: string, params?: unknown[]) {
          if (text.includes('CREATE TABLE') && failCreate) {
            failCreate = false;
            throw new Error('create failed');
          }
          return client.query<T>(text, params);
        },
        release: client.release,
      };
    };

    const store = new PostgresRateLimiterStore(pool);

    await assert.rejects(
      store.check('retry-table', { maxRequests: 1, now, windowMs: 1_000 }),
      /create failed/,
    );
    assert.deepEqual(
      await store.check('retry-table', { maxRequests: 1, now, windowMs: 1_000 }),
      { allowed: true },
    );
  });
});

describe('createConfiguredRateLimiter', () => {
  test('uses default settings when no explicit limiter options are provided', async () => {
    const limiter = createConfiguredRateLimiter({});

    assert.ok(limiter instanceof InMemoryRateLimiter);
    assert.deepEqual(await limiter.check('default-key'), { allowed: true });
  });

  test('falls back to the in-memory limiter when persistence is not configured', () => {
    const limiter = createConfiguredRateLimiter({
      maxRequests: 4,
      store: 'memory',
      windowMs: 2_000,
    });

    assert.ok(limiter instanceof InMemoryRateLimiter);
  });

  test('requires a pool when the postgres store is selected', () => {
    assert.throws(
      () =>
        createConfiguredRateLimiter({
          maxRequests: 4,
          store: 'postgres',
          windowMs: 2_000,
        }),
      /PostgreSQL pool is required/,
    );
  });

  test('creates an in-memory limiter with default constructor values', async () => {
    const limiter = createRateLimiter();

    assert.deepEqual(await limiter.check('constructor-defaults'), { allowed: true });
  });

  test('identifies persistent stores for callers that need special handling', () => {
    assert.equal(isPersistentRateLimiterStore(new InMemoryRateLimiterStore()), false);
    assert.equal(
      isPersistentRateLimiterStore(new PostgresRateLimiterStore(new MockPersistentPool())),
      true,
    );
  });
});

describe('resolveRateLimiterConfig', () => {
  test('maps a memory store config without a tableName field', () => {
    const result = resolveRateLimiterConfig({
      maxRequests: 5,
      windowMs: 60_000,
      store: 'memory',
      postgresTable: 'gateway_rate_limit_buckets',
    });

    assert.deepEqual(result, {
      store: 'memory',
      maxRequests: 5,
      windowMs: 60_000,
    });
    assert.equal('tableName' in result, false);
  });

  test('maps a postgres store config, carrying postgresTable over as tableName', () => {
    const result = resolveRateLimiterConfig({
      maxRequests: 50,
      windowMs: 10_000,
      store: 'postgres',
      postgresTable: 'custom_rate_limit_buckets',
    });

    assert.deepEqual(result, {
      store: 'postgres',
      maxRequests: 50,
      windowMs: 10_000,
      tableName: 'custom_rate_limit_buckets',
    });
  });

  test('feeds directly into createConfiguredRateLimiter for the memory case', async () => {
    const limiter = createConfiguredRateLimiter(
      resolveRateLimiterConfig({
        maxRequests: 1,
        windowMs: 60_000,
        store: 'memory',
        postgresTable: 'gateway_rate_limit_buckets',
      }),
    );

    assert.ok(limiter instanceof InMemoryRateLimiter);
    assert.deepEqual(await limiter.check('resolve-config-key'), { allowed: true });
    const second = await limiter.check('resolve-config-key');
    assert.equal(second.allowed, false);
    assert.ok((second.retryAfterMs ?? 0) > 0 && (second.retryAfterMs ?? 0) <= 60_000);
  });

  test('feeds directly into createConfiguredRateLimiter for the postgres case', () => {
    assert.throws(
      () =>
        createConfiguredRateLimiter(
          resolveRateLimiterConfig({
            maxRequests: 5,
            windowMs: 60_000,
            store: 'postgres',
            postgresTable: 'gateway_rate_limit_buckets',
          }),
        ),
      /PostgreSQL pool is required/,
    );
  });
});
