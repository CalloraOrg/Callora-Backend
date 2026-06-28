/**
 * replicaPool.test.ts
 *
 * Comprehensive tests for the replica routing infrastructure.
 * Covers:
 *   - reads routed to replicas
 *   - writes routed to primary
 *   - no replicas configured (all → primary)
 *   - replica failure → primary fallback
 *   - round-robin distribution
 *   - metrics emitted for each scenario
 *   - invalid REPLICA_URLS configuration
 *   - concurrent read routing
 *
 * NOTE: env, logger, and metrics are mocked so this suite runs without a
 * real database connection or complete .env file.
 */

// ── Mocks (must be hoisted before any imports that pull those modules) ─────────

// Mock the env module so we don't need all required env vars set in CI.
jest.mock('../config/env', () => ({
  env: {
    REPLICA_URLS: undefined,
    DB_POOL_MAX: 10,
    DB_IDLE_TIMEOUT_MS: 30_000,
    DB_CONN_TIMEOUT_MS: 2_000,
  },
}));

// Mock logger — prevents pino setup from failing and keeps output clean.
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getRequestId: jest.fn(() => undefined),
}));

// Track metric call counts manually so we can assert without Prometheus.
const mockMetrics = {
  recordReplicaQuery: jest.fn(),
  recordPrimaryQuery: jest.fn(),
  recordReplicaFallback: jest.fn(),
  recordReplicaFailure: jest.fn(),
};

jest.mock('../metrics', () => ({
  ...mockMetrics,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  ReplicaPool,
  parseReplicaUrls,
  _resetReplicaPool,
  getReplicaPool,
} from '../db/replicaPool.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal pg.Pool stub. */
function makePoolStub(rows: unknown[] = [], shouldReject = false) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (shouldReject) throw new Error('Pool connection error');
      return { rows };
    }),
    end: jest.fn().mockResolvedValue(undefined),
    _calls: calls,
  };
}

// Reset mock call counts before each test.
beforeEach(() => {
  jest.clearAllMocks();
});

// ── parseReplicaUrls ──────────────────────────────────────────────────────────

describe('parseReplicaUrls', () => {
  test('returns empty array for undefined', () => {
    expect(parseReplicaUrls(undefined)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(parseReplicaUrls('')).toEqual([]);
  });

  test('returns empty array for whitespace-only string', () => {
    expect(parseReplicaUrls('   ')).toEqual([]);
  });

  test('parses a single postgresql:// URL', () => {
    expect(parseReplicaUrls('postgresql://user:pass@host:5432/db')).toEqual([
      'postgresql://user:pass@host:5432/db',
    ]);
  });

  test('parses multiple comma-separated URLs', () => {
    const urls = parseReplicaUrls(
      'postgresql://a:b@r1:5432/db,postgresql://a:b@r2:5432/db',
    );
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('postgresql://a:b@r1:5432/db');
    expect(urls[1]).toBe('postgresql://a:b@r2:5432/db');
  });

  test('trims whitespace around individual URLs', () => {
    const urls = parseReplicaUrls(
      ' postgresql://a:b@r1:5432/db , postgresql://a:b@r2:5432/db ',
    );
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('postgresql://a:b@r1:5432/db');
    expect(urls[1]).toBe('postgresql://a:b@r2:5432/db');
  });

  test('accepts postgres:// scheme', () => {
    expect(() => parseReplicaUrls('postgres://user:pass@host:5432/db')).not.toThrow();
  });

  test('throws on non-URL string', () => {
    expect(() => parseReplicaUrls('not-a-url')).toThrow(/not a valid URL/i);
  });

  test('throws on non-postgresql scheme', () => {
    expect(() => parseReplicaUrls('mysql://user:pass@host:3306/db')).toThrow(
      /postgresql:\/\/ or postgres:\/\/ scheme/i,
    );
  });

  test('throws on empty segment between commas', () => {
    expect(() =>
      parseReplicaUrls('postgresql://a:b@r1:5432/db,,postgresql://a:b@r2:5432/db'),
    ).toThrow(/empty after trimming/i);
  });
});

// ── TestableReplicaPool (injects stub pg pools) ───────────────────────────────

/**
 * Build a ReplicaPool instance with stubbed replica arrays injected directly,
 * bypassing the real pg.Pool constructor (which would need real DB URLs).
 */
function buildTestablePool(
  primary: ReturnType<typeof makePoolStub>,
  replicaStubs: Array<ReturnType<typeof makePoolStub>>,
): ReplicaPool {
  const instance = Object.create(ReplicaPool.prototype) as ReplicaPool;
  Object.defineProperty(instance, 'primary', { value: primary, writable: true });
  Object.defineProperty(instance, 'replicaPools', { value: replicaStubs, writable: true });
  Object.defineProperty(instance, 'roundRobinIndex', { value: 0, writable: true });
  return instance;
}

// ── No replicas configured ────────────────────────────────────────────────────

describe('ReplicaPool — no replicas configured', () => {
  let primary: ReturnType<typeof makePoolStub>;
  let rp: ReplicaPool;

  beforeEach(() => {
    primary = makePoolStub([{ id: 1 }]);
    rp = buildTestablePool(primary, []);
  });

  test('hasReplicas is false', () => {
    expect(rp.hasReplicas).toBe(false);
  });

  test('replicaCount is 0', () => {
    expect(rp.replicaCount).toBe(0);
  });

  test('read() routes to primary', async () => {
    const result = await rp.read('SELECT 1');
    expect(primary.query).toHaveBeenCalledTimes(1);
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  test('write() routes to primary', async () => {
    await rp.write('INSERT INTO foo VALUES ($1)', [42]);
    expect(primary.query).toHaveBeenCalledWith('INSERT INTO foo VALUES ($1)', [42]);
  });

  test('read() calls recordPrimaryQuery metric', async () => {
    await rp.read('SELECT 1');
    expect(mockMetrics.recordPrimaryQuery).toHaveBeenCalledTimes(1);
    expect(mockMetrics.recordReplicaQuery).not.toHaveBeenCalled();
  });

  test('write() calls recordPrimaryQuery metric', async () => {
    await rp.write('INSERT 1');
    expect(mockMetrics.recordPrimaryQuery).toHaveBeenCalledTimes(1);
  });
});

// ── Reads routed to replicas ──────────────────────────────────────────────────

describe('ReplicaPool — reads routed to replicas', () => {
  let primary: ReturnType<typeof makePoolStub>;
  let replica1: ReturnType<typeof makePoolStub>;
  let replica2: ReturnType<typeof makePoolStub>;
  let rp: ReplicaPool;

  beforeEach(() => {
    primary = makePoolStub([{ primary: true }]);
    replica1 = makePoolStub([{ replica: 1 }]);
    replica2 = makePoolStub([{ replica: 2 }]);
    rp = buildTestablePool(primary, [replica1, replica2]);
  });

  test('hasReplicas is true', () => {
    expect(rp.hasReplicas).toBe(true);
  });

  test('replicaCount equals number of stubs', () => {
    expect(rp.replicaCount).toBe(2);
  });

  test('read() routes to first replica on first call', async () => {
    const result = await rp.read('SELECT 1');
    expect(replica1.query).toHaveBeenCalledTimes(1);
    expect(primary.query).not.toHaveBeenCalled();
    expect(result.rows).toEqual([{ replica: 1 }]);
  });

  test('write() always routes to primary, never replicas', async () => {
    await rp.write('INSERT INTO t VALUES ($1)', ['v']);
    expect(primary.query).toHaveBeenCalledWith('INSERT INTO t VALUES ($1)', ['v']);
    expect(replica1.query).not.toHaveBeenCalled();
    expect(replica2.query).not.toHaveBeenCalled();
  });

  test('read() calls recordReplicaQuery metric', async () => {
    await rp.read('SELECT 1');
    expect(mockMetrics.recordReplicaQuery).toHaveBeenCalledTimes(1);
    expect(mockMetrics.recordPrimaryQuery).not.toHaveBeenCalled();
  });

  test('write() calls recordPrimaryQuery, not recordReplicaQuery', async () => {
    await rp.write('INSERT 1');
    expect(mockMetrics.recordPrimaryQuery).toHaveBeenCalledTimes(1);
    expect(mockMetrics.recordReplicaQuery).not.toHaveBeenCalled();
  });
});

// ── Round-robin distribution ──────────────────────────────────────────────────

describe('ReplicaPool — round-robin distribution', () => {
  let primary: ReturnType<typeof makePoolStub>;
  let replica1: ReturnType<typeof makePoolStub>;
  let replica2: ReturnType<typeof makePoolStub>;
  let replica3: ReturnType<typeof makePoolStub>;
  let rp: ReplicaPool;

  beforeEach(() => {
    primary = makePoolStub();
    replica1 = makePoolStub([{ r: 1 }]);
    replica2 = makePoolStub([{ r: 2 }]);
    replica3 = makePoolStub([{ r: 3 }]);
    rp = buildTestablePool(primary, [replica1, replica2, replica3]);
  });

  test('distributes reads across replicas in round-robin order', async () => {
    await rp.read('S'); // → replica1
    await rp.read('S'); // → replica2
    await rp.read('S'); // → replica3
    await rp.read('S'); // → replica1 again

    expect(replica1.query).toHaveBeenCalledTimes(2);
    expect(replica2.query).toHaveBeenCalledTimes(1);
    expect(replica3.query).toHaveBeenCalledTimes(1);
    expect(primary.query).not.toHaveBeenCalled();
  });

  test('wraps around evenly after a full cycle', async () => {
    for (let i = 0; i < 6; i++) await rp.read('S');
    expect(replica1.query).toHaveBeenCalledTimes(2);
    expect(replica2.query).toHaveBeenCalledTimes(2);
    expect(replica3.query).toHaveBeenCalledTimes(2);
  });
});

// ── Replica failure fallback ──────────────────────────────────────────────────

describe('ReplicaPool — replica failure fallback', () => {
  let primary: ReturnType<typeof makePoolStub>;
  let failingReplica: ReturnType<typeof makePoolStub>;
  let rp: ReplicaPool;

  beforeEach(() => {
    primary = makePoolStub([{ primary: true }]);
    failingReplica = makePoolStub([], true); // always rejects
    rp = buildTestablePool(primary, [failingReplica]);
  });

  test('read() falls back to primary when replica throws', async () => {
    const result = await rp.read('SELECT 1');
    expect(failingReplica.query).toHaveBeenCalledTimes(1);
    expect(primary.query).toHaveBeenCalledTimes(1);
    expect(result.rows).toEqual([{ primary: true }]);
  });

  test('calls recordReplicaFailure on replica error', async () => {
    await rp.read('SELECT 1');
    expect(mockMetrics.recordReplicaFailure).toHaveBeenCalledTimes(1);
  });

  test('calls recordReplicaFallback when falling back to primary', async () => {
    await rp.read('SELECT 1');
    expect(mockMetrics.recordReplicaFallback).toHaveBeenCalledTimes(1);
  });

  test('calls recordPrimaryQuery for the fallback query', async () => {
    await rp.read('SELECT 1');
    expect(mockMetrics.recordPrimaryQuery).toHaveBeenCalledTimes(1);
  });

  test('does NOT call recordReplicaQuery when replica fails', async () => {
    await rp.read('SELECT 1');
    expect(mockMetrics.recordReplicaQuery).not.toHaveBeenCalled();
  });

  test('throws when both replica AND primary fail', async () => {
    const alsoFailing = makePoolStub([], true);
    const brokenRp = buildTestablePool(alsoFailing, [failingReplica]);
    await expect(brokenRp.read('SELECT 1')).rejects.toThrow('Pool connection error');
  });

  test('write() never touches replica even when primary fails', async () => {
    const failingPrimary = makePoolStub([], true);
    const rp2 = buildTestablePool(failingPrimary, [failingReplica]);

    await expect(rp2.write('INSERT 1')).rejects.toThrow();
    // Replica MUST NOT have been queried
    expect(failingReplica.query).not.toHaveBeenCalled();
  });
});

// ── Concurrent reads ──────────────────────────────────────────────────────────

describe('ReplicaPool — concurrent reads', () => {
  test('12 concurrent reads across 3 replicas — no races, all served', async () => {
    const primary = makePoolStub([]);
    const replicas = [
      makePoolStub([{ r: 1 }]),
      makePoolStub([{ r: 2 }]),
      makePoolStub([{ r: 3 }]),
    ];
    const rp = buildTestablePool(primary, replicas);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => rp.read('SELECT 1')),
    );

    expect(results).toHaveLength(12);

    const total =
      replicas[0].query.mock.calls.length +
      replicas[1].query.mock.calls.length +
      replicas[2].query.mock.calls.length;
    expect(total).toBe(12);

    expect(primary.query).not.toHaveBeenCalled();
  });
});

// ── closeAll ──────────────────────────────────────────────────────────────────

describe('ReplicaPool — closeAll', () => {
  test('calls end() on every replica pool', async () => {
    const primary = makePoolStub();
    const r1 = makePoolStub();
    const r2 = makePoolStub();
    const rp = buildTestablePool(primary, [r1, r2]);

    await rp.closeAll();

    expect(r1.end).toHaveBeenCalledTimes(1);
    expect(r2.end).toHaveBeenCalledTimes(1);
    // Primary is NOT closed by closeAll — that's the caller's responsibility
    expect(primary.end).not.toHaveBeenCalled();
  });
});

// ── getReplicaPool singleton ──────────────────────────────────────────────────

describe('getReplicaPool singleton', () => {
  beforeEach(() => _resetReplicaPool());
  afterEach(() => _resetReplicaPool());

  test('returns the same instance on repeated calls', () => {
    const primary = makePoolStub() as unknown as import('pg').Pool;
    expect(getReplicaPool(primary)).toBe(getReplicaPool(primary));
  });

  test('returns a ReplicaPool instance', () => {
    const primary = makePoolStub() as unknown as import('pg').Pool;
    expect(getReplicaPool(primary)).toBeInstanceOf(ReplicaPool);
  });
});
