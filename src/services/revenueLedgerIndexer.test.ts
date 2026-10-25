import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import {
  PgUsageEventsRepository,
  type UsageEventsRepositoryQueryable,
} from '../repositories/usageEventsRepository.pg.js';
import {
  RevenueLedgerIndexer,
  createRevenueLedgerIndexerJob,
} from './revenueLedgerIndexer.js';

// The indexer relies on PostgreSQL features pg-mem does not emulate
// (multi-join lookups, GREATEST on timestamps, ON CONFLICT ... WHERE and
// advisory locks), so the database-backed tests run against a real
// PostgreSQL. Each harness gets its own database under Docker; with
// CALLORA_TEST_DISPOSABLE_DATABASE_URL it gets its own schema instead, because
// the app role cannot CREATE DATABASE there.
let container: StartedTestContainer | undefined;
let adminPool: InstanceType<typeof pg.Pool> | undefined;
let databaseCounter = 0;
const disposableDatabaseUrl = process.env.CALLORA_TEST_DISPOSABLE_DATABASE_URL;

function databaseUrl(name: string): string {
  if (!container) throw new Error('PostgreSQL container is not running');
  return `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/${name}`;
}

beforeAll(async () => {
  if (disposableDatabaseUrl) {
    adminPool = new pg.Pool({ connectionString: disposableDatabaseUrl });
    return;
  }
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'postgres' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  adminPool = new pg.Pool({ connectionString: databaseUrl('postgres') });
}, 120_000);

afterAll(async () => {
  await adminPool?.end();
  await container?.stop();
});

async function createIndexerHarness() {
  databaseCounter += 1;
  const name = `revenue_indexer_${databaseCounter}`;
  // Native: a unique schema per harness, with every pooled connection pinned to it by search_path.
  // Docker: a database per harness.
  const schema = disposableDatabaseUrl ? `${name}_${randomUUID().replace(/-/g, '')}` : undefined;
  await adminPool!.query(schema ? `CREATE SCHEMA ${schema}` : `CREATE DATABASE ${name}`);
  const pool = new pg.Pool(
    schema
      ? { connectionString: disposableDatabaseUrl, options: `-c search_path=${schema}` }
      : { connectionString: databaseUrl(name) },
  );
  // Native cleanup drops only this harness's schema. Docker keeps its database, as before.
  const close = async (): Promise<void> => {
    try {
      await pool.end();
    } finally {
      if (schema) await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  };
  try {

    await pool.query(`
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

    CREATE TABLE apis (
      id VARCHAR(255) PRIMARY KEY,
      developer_id VARCHAR(255) NOT NULL
    );

    CREATE TABLE revenue_ledger (
      id BIGSERIAL PRIMARY KEY,
      api_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL,
      amount_usdc NUMERIC(20, 0) NOT NULL,
      usage_event_id BIGINT UNIQUE REFERENCES usage_events(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      settlement_id BIGINT,
      reversed_at TIMESTAMP,
      reversal_of_usage_event_id BIGINT UNIQUE
    );

    CREATE TABLE indexer_checkpoints (name VARCHAR(128) PRIMARY KEY, last_usage_event_id BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMP NOT NULL DEFAULT NOW(), locked_until TIMESTAMP);
    CREATE TABLE revenue_ledger_skips (usage_event_id BIGINT PRIMARY KEY REFERENCES usage_events(id), reason VARCHAR(64) NOT NULL, first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(), attempts INTEGER NOT NULL DEFAULT 1, next_retry_at TIMESTAMP NOT NULL DEFAULT NOW(), permanent BOOLEAN NOT NULL DEFAULT FALSE);
    `);
  } catch (error) {
    await close();
    throw error;
  }

  const repository = new PgUsageEventsRepository(pool as unknown as UsageEventsRepositoryQueryable);

  return { pool, repository, close };
}

test('RevenueLedgerIndexer backfills unindexed usage events in cursor-ordered batches', async () => {
  const { pool, repository, close } = await createIndexerHarness();

  try {
    await pool.query(
      'INSERT INTO apis (id, developer_id) VALUES ($1, $2), ($3, $4)',
      ['api-1', 'dev-1', 'api-2', 'dev-2'],
    );

    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-1',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-1',
      stellarTxHash: 'tx-1',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'consumer-2',
      apiId: 'api-2',
      endpointId: 'endpoint-2',
      apiKeyId: 'key-2',
      developerId: 'dev-1',
      amount: 200n,
      requestId: 'req-2',
      stellarTxHash: 'tx-2',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'consumer-3',
      apiId: 'api-1',
      endpointId: 'endpoint-3',
      apiKeyId: 'key-3',
      developerId: 'dev-1',
      amount: 300n,
      requestId: 'req-3',
      stellarTxHash: 'tx-3',
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
    });

    const indexer = new RevenueLedgerIndexer(repository, {
      batchSize: 2,
      resolveDeveloperId: async (apiId) => `dev-${apiId.replace('api-', '')}`,
    });
    const firstRun = await indexer.runOnce();
    const secondRun = await indexer.runOnce();
    const rows = await pool.query(
      `
        SELECT usage_event_id::text, api_id, developer_id, amount_usdc::text
        FROM revenue_ledger
        ORDER BY usage_event_id ASC
      `,
    );

    assert.deepEqual(firstRun, { scanned: 3, inserted: 3 });
    assert.deepEqual(secondRun, { scanned: 0, inserted: 0 });
    assert.deepEqual(rows.rows, [
      { usage_event_id: '1', api_id: 'api-1', developer_id: 'dev-1', amount_usdc: '100' },
      { usage_event_id: '2', api_id: 'api-2', developer_id: 'dev-2', amount_usdc: '200' },
      { usage_event_id: '3', api_id: 'api-1', developer_id: 'dev-1', amount_usdc: '300' },
    ]);
  } finally {
    await close();
  }
});

test('only confirmed on-chain charges are accrued, and a pending charge is picked up after confirmation', async () => {
  const { pool, repository, close } = await createIndexerHarness();
  try {
    await pool.query("ALTER TABLE usage_events ADD COLUMN deduction_status VARCHAR(16) NOT NULL DEFAULT 'pending'");
    await pool.query('INSERT INTO apis (id, developer_id) VALUES ($1, $2)', ['api-1', 'dev-1']);
    await repository.create({ userId: 'c1', apiId: 'api-1', endpointId: 'e1', apiKeyId: 'k1', amount: 10n, requestId: 'confirmed', stellarTxHash: 'tx-confirmed' });
    await repository.create({ userId: 'c2', apiId: 'api-1', endpointId: 'e2', apiKeyId: 'k2', amount: 20n, requestId: 'pending' });
    await pool.query("UPDATE usage_events SET deduction_status = 'confirmed' WHERE request_id = 'confirmed'");

    const indexer = new RevenueLedgerIndexer(repository, { resolveDeveloperId: async () => 'dev-1' });
    const first = await indexer.runOnce();
    assert.deepEqual(first, { scanned: 2, inserted: 1 });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM revenue_ledger')).rows[0]?.count, 1);

    await pool.query("UPDATE usage_events SET stellar_tx_hash = 'tx-pending', deduction_status = 'confirmed' WHERE request_id = 'pending'");
    await pool.query("UPDATE revenue_ledger_skips SET next_retry_at = NOW() - INTERVAL '1 second' WHERE reason = 'pending'");
    const second = await indexer.runOnce();
    assert.equal(second.inserted, 1);

    const invariant = await pool.query(`
      SELECT COUNT(*)::int AS count FROM revenue_ledger rl
      JOIN usage_events ue ON ue.id = rl.usage_event_id
      WHERE (ue.stellar_tx_hash IS NULL OR ue.deduction_status = 'voided')
        AND rl.reversed_at IS NULL
    `);
    assert.equal(invariant.rows[0]?.count, 0);
    assert.equal((await repository.getRevenueLedgerCheckpoint()), '2');
  } finally {
    await close();
  }
});

test('unknown APIs are persisted with retry backoff and do not block later events', async () => {
  const { pool, repository, close } = await createIndexerHarness();
  try {
    await pool.query("INSERT INTO apis (id, developer_id) VALUES ('api-known', 'dev-1')");
    await repository.create({ userId: 'c1', apiId: 'api-missing', endpointId: 'e1', apiKeyId: 'k1', amount: 10n, requestId: 'poison', stellarTxHash: 'tx-poison' });
    await repository.create({ userId: 'c2', apiId: 'api-known', endpointId: 'e2', apiKeyId: 'k2', amount: 20n, requestId: 'healthy', stellarTxHash: 'tx-healthy' });
    const resolveDeveloperId = jest.fn(async (apiId: string) => apiId === 'api-known' ? 'dev-1' : undefined);
    const indexer = new RevenueLedgerIndexer(repository, { resolveDeveloperId });

    const first = await indexer.runOnce();
    const second = await indexer.runOnce();
    const skip = await pool.query('SELECT reason, attempts, permanent FROM revenue_ledger_skips WHERE usage_event_id = 1');
    const ledger = await pool.query('SELECT usage_event_id::text FROM revenue_ledger');
    assert.equal(first.inserted, 1);
    assert.equal(second.scanned, 0);
    expect(resolveDeveloperId).toHaveBeenCalledTimes(2);
    assert.equal(skip.rows[0]?.reason, 'unknown_api');
    assert.equal(skip.rows[0]?.attempts, 1);
    assert.deepEqual(ledger.rows, [{ usage_event_id: '2' }]);
    assert.equal(await repository.getRevenueLedgerCheckpoint(), '2');
  } finally {
    await close();
  }
});

test('database lease prevents concurrent indexer instances from scanning together', async () => {
  const { repository, close } = await createIndexerHarness();
  try {
    assert.equal(await repository.acquireRevenueLedgerIndexerLock(), true);
    assert.equal(await repository.acquireRevenueLedgerIndexerLock(), false);
    await repository.releaseRevenueLedgerIndexerLock();
    assert.equal(await repository.acquireRevenueLedgerIndexerLock(), true);
    await repository.releaseRevenueLedgerIndexerLock();
  } finally {
    await close();
  }
});

test('RevenueLedgerIndexerJob drains in-flight work during shutdown', async () => {
  jest.useFakeTimers();

  try {
    let releaseFirstQuery!: () => void;
    const repository = {
      findUnindexedRevenueLedgerEvents: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirstQuery = () => {
                resolve([
                  {
                    usageEventId: '1',
                    apiId: 'api-1',
                    developerId: 'dev-1',
                    amount: 100n,
                    createdAt: new Date('2026-02-01T10:00:00.000Z'),
                    stellarTxHash: 'tx-1',
                  },
                ]);
              };
            }),
        )
        .mockResolvedValueOnce([]),
      indexRevenueLedgerEvent: jest.fn().mockResolvedValue(true),
    } as unknown as PgUsageEventsRepository;

    const job = createRevenueLedgerIndexerJob(repository, {
      intervalMs: 1_000,
      batchSize: 10,
      logger: { error: jest.fn() },
      resolveDeveloperId: async (apiId) => `dev-${apiId.replace('api-', '')}`,
    });

    job.start();
    for (let i = 0; i < 20 && typeof releaseFirstQuery !== 'function'; i += 1) {
      await Promise.resolve();
    }

    const idlePromise = job.awaitIdle();
    let settled = false;
    void idlePromise.then(() => {
      settled = true;
    });

    job.beginShutdown();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();

    assert.equal(settled, false);
    releaseFirstQuery();
    await idlePromise;

    expect(repository.indexRevenueLedgerEvent).toHaveBeenCalledTimes(1);
    assert.equal(settled, true);
  } finally {
    jest.useRealTimers();
  }
});

test('RevenueLedgerIndexer validates configuration and logs insert failures', async () => {
  assert.throws(
    () =>
      new RevenueLedgerIndexer(
        {
          findUnindexedRevenueLedgerEvents: async () => [],
          indexRevenueLedgerEvent: async () => true,
        } as unknown as PgUsageEventsRepository,
        { batchSize: 0 },
      ),
    /batchSize must be a positive integer\./,
  );

  const logger = { error: jest.fn() };
  const repository = {
    findUnindexedRevenueLedgerEvents: jest
      .fn()
      .mockResolvedValueOnce([
        {
          usageEventId: '9',
          apiId: 'api-9',
          developerId: 'dev-9',
          amount: 999n,
          createdAt: new Date('2026-02-09T10:00:00.000Z'),
          stellarTxHash: 'tx-9',
        },
      ]),
    indexRevenueLedgerEvent: jest.fn().mockRejectedValue(new Error('boom')),
  } as unknown as PgUsageEventsRepository;

  const indexer = new RevenueLedgerIndexer(repository, {
    logger,
    resolveDeveloperId: async (apiId) => `dev-${apiId.replace('api-', '')}`,
  });

  await assert.rejects(indexer.runOnce(), /boom/);
  await indexer.awaitIdle();
  expect(logger.error).toHaveBeenCalledWith(
    'Revenue ledger indexing failed for usage event',
    expect.objectContaining({ usageEventId: '9' }),
  );
});

test('RevenueLedgerIndexerJob validates interval and skips overlapping ticks', async () => {
  assert.throws(
    () =>
      createRevenueLedgerIndexerJob(
        {
          findUnindexedRevenueLedgerEvents: async () => [],
          indexRevenueLedgerEvent: async () => true,
        } as unknown as PgUsageEventsRepository,
        { intervalMs: 0 },
      ),
    /intervalMs must be a positive integer\./,
  );

  jest.useFakeTimers();

  try {
    let release!: () => void;
    const repository = {
      findUnindexedRevenueLedgerEvents: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve([]);
            }),
        ),
      indexRevenueLedgerEvent: jest.fn(),
    } as unknown as PgUsageEventsRepository;

    const job = createRevenueLedgerIndexerJob(repository, {
      intervalMs: 100,
      batchSize: 10,
      logger: { error: jest.fn() },
      resolveDeveloperId: async (apiId) => `dev-${apiId.replace('api-', '')}`,
    });

    job.stop();
    job.start();
    job.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(repository.findUnindexedRevenueLedgerEvents).toHaveBeenCalledTimes(1);

    release();
    await job.awaitIdle();

    job.beginShutdown();
    job.start();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(repository.findUnindexedRevenueLedgerEvents).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('RevenueLedgerIndexerJob logs job failures and stop is safe when idle', async () => {
  const logger = { error: jest.fn() };
  const repository = {
    findUnindexedRevenueLedgerEvents: jest.fn().mockResolvedValueOnce([
      {
        usageEventId: '11',
        apiId: 'api-11',
        developerId: 'dev-11',
        amount: 11n,
        createdAt: new Date('2026-02-11T10:00:00.000Z'),
        stellarTxHash: 'tx-11',
      },
    ]),
    indexRevenueLedgerEvent: jest.fn().mockRejectedValue(new Error('job-failure')),
  } as unknown as PgUsageEventsRepository;

  const job = createRevenueLedgerIndexerJob(repository, {
    intervalMs: 1_000,
    batchSize: 10,
    logger,
    resolveDeveloperId: async (apiId) => `dev-${apiId.replace('api-', '')}`,
  });

  job.stop();
  job.start();
  await expect(job.awaitIdle()).rejects.toThrow('job-failure');
  job.stop();

  expect(logger.error).toHaveBeenCalledWith(
    'Revenue ledger indexer job failed:',
    expect.any(Error),
  );
});
