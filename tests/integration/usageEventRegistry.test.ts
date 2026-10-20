import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import pg from 'pg';
import { PgUsageEventsRepository } from '../../src/repositories/usageEventsRepository.pg.js';
import { BillingService } from '../../src/services/billing.js';
import { PostgresUsageStore } from '../../src/services/usageStore.js';

const { Pool } = pg;

describe('partitioned usage event global request ID registry', () => {
  let container: StartedTestContainer;
  let pool: InstanceType<typeof Pool>;
  let repository: PgUsageEventsRepository;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'callora_test' })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();
    databaseUrl = `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/callora_test`;
    pool = new Pool({ connectionString: databaseUrl });

    await pool.query(`
      CREATE TABLE apis (id VARCHAR(255) PRIMARY KEY, developer_id VARCHAR(255) NOT NULL);
      INSERT INTO apis VALUES ('api-a', 'developer-a'), ('api-b', 'developer-b');
      CREATE TABLE usage_events_old (
        id BIGSERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        api_id VARCHAR(255) NOT NULL,
        endpoint_id VARCHAR(255) NOT NULL,
        api_key_id VARCHAR(255) NOT NULL,
        developer_id VARCHAR(255) NOT NULL DEFAULT '',
        amount_usdc NUMERIC(20, 0) NOT NULL,
        request_id VARCHAR(255) NOT NULL,
        stellar_tx_hash VARCHAR(64),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      INSERT INTO usage_events_old (user_id, api_id, endpoint_id, api_key_id, developer_id, amount_usdc, request_id)
      VALUES ('user-old', 'api-a', 'endpoint-old', 'key-old', 'developer-a', 7, 'legacy-request');
      CREATE TABLE usage_events_partitioned (
        id BIGSERIAL,
        user_id VARCHAR(255) NOT NULL,
        api_id VARCHAR(255) NOT NULL,
        endpoint_id VARCHAR(255) NOT NULL,
        api_key_id VARCHAR(255) NOT NULL,
        developer_id VARCHAR(255) NOT NULL DEFAULT '',
        amount_usdc NUMERIC(20, 0) NOT NULL,
        request_id VARCHAR(255) NOT NULL,
        stellar_tx_hash VARCHAR(64),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, developer_id),
        UNIQUE (request_id, developer_id)
      ) PARTITION BY HASH (developer_id);
      CREATE TABLE usage_events_p0 PARTITION OF usage_events_partitioned FOR VALUES WITH (MODULUS 2, REMAINDER 0);
      CREATE TABLE usage_events_p1 PARTITION OF usage_events_partitioned FOR VALUES WITH (MODULUS 2, REMAINDER 1);
      ALTER TABLE usage_events_partitioned RENAME TO usage_events;
      CREATE TABLE revenue_ledger (
        id BIGSERIAL PRIMARY KEY,
        api_id VARCHAR(255) NOT NULL DEFAULT '',
        developer_id VARCHAR(255) NOT NULL DEFAULT '',
        amount_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
        usage_event_id BIGINT UNIQUE REFERENCES usage_events_old(id),
        settlement_id BIGINT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE settlements (id BIGSERIAL PRIMARY KEY, external_id VARCHAR(255));
    `);

    const migration = await readFile(join(process.cwd(), 'migrations/0027_usage_event_request_ids.sql'), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    repository = new PgUsageEventsRepository(pool);
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  test('migration backfills legacy IDs, restores store columns, and repoints the ledger FK', async () => {
    const migrated = await pool.query<{ request_id: string; developer_id: string }>(
      'SELECT request_id, developer_id FROM usage_event_request_ids WHERE request_id = $1', ['legacy-request'],
    );
    assert.deepEqual(migrated.rows, [{ request_id: 'legacy-request', developer_id: 'developer-a' }]);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'usage_events' AND column_name IN ('api_key', 'status_code') ORDER BY column_name`,
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), ['api_key', 'status_code']);

    const legacyId = await pool.query<{ usage_event_id: string }>(
      'SELECT usage_event_id FROM usage_event_request_ids WHERE request_id = $1', ['legacy-request'],
    );
    await pool.query('INSERT INTO revenue_ledger (usage_event_id) VALUES ($1)', [legacyId.rows[0]?.usage_event_id]);
    await assert.rejects(
      pool.query('INSERT INTO revenue_ledger (usage_event_id) VALUES (987654321)'),
      /foreign key constraint/i,
    );
  });

  test('same request ID across different API owners commits exactly one event', async () => {
    const args = (apiId: string, userId: string) => ({
      apiId, userId, endpointId: 'endpoint', apiKeyId: 'key', amount: 100n, requestId: 'concurrent-global-request',
    });
    const [first, second] = await Promise.all([
      repository.create(args('api-a', 'user-a')),
      repository.create(args('api-b', 'user-b')),
    ]);
    assert.equal(first.id, second.id);
    const stored = await pool.query<{ count: string; developer_id: string }>(
      `SELECT COUNT(*)::text AS count, MIN(developer_id) AS developer_id
         FROM usage_events WHERE request_id = $1`, ['concurrent-global-request'],
    );
    assert.equal(stored.rows[0]?.count, '1');
    assert.ok(['developer-a', 'developer-b'].includes(stored.rows[0]?.developer_id ?? ''));
    const registry = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM usage_event_request_ids WHERE request_id = $1', ['concurrent-global-request'],
    );
    assert.equal(registry.rows[0]?.count, '1');
    const retry = await repository.create(args('api-a', 'retry-user'));
    assert.equal(retry.id, first.id);
    assert.equal(retry.developerId, first.developerId);
  });

  test('unknown API is a typed 404 and writes no registry or usage row', async () => {
    await assert.rejects(
      repository.create({
        apiId: 'missing-api', userId: 'user', endpointId: 'endpoint', apiKeyId: 'key',
        amount: 1n, requestId: 'unknown-api-request',
      }),
      (error: unknown) => error instanceof Error && (error as Error & { statusCode?: number; code?: string }).statusCode === 404
        && (error as Error & { code?: string }).code === 'API_NOT_FOUND',
    );
    const billing = new BillingService(pool, {
      async getBalance() { return { balance: '1000000000' }; },
      async deductBalance() { return { txHash: 'unused' }; },
    });
    const request = {
      requestId: 'unknown-billing-api', userId: 'user', apiId: 'missing-api',
      endpointId: 'endpoint', apiKeyId: 'key', amountUsdc: '1',
    };
    const single = await billing.deduct(request);
    assert.equal(single.errorCode, 'API_NOT_FOUND');
    assert.equal(single.success, false);
    const bulk = await billing.deductBulk([request]);
    assert.equal(bulk.errorCode, 'API_NOT_FOUND');
    assert.equal(bulk.success, false);
    const result = await pool.query(
      `SELECT 1 FROM usage_event_request_ids WHERE request_id IN ('unknown-api-request', 'unknown-billing-api')
       UNION ALL SELECT 1 FROM usage_events WHERE request_id IN ('unknown-api-request', 'unknown-billing-api')`,
    );
    assert.equal(result.rowCount, 0);
  });

  test('PostgresUsageStore persists and reads api_key and status_code on the partitioned table', async () => {
    const store = new PostgresUsageStore(pool);
    const didRecord = await store.record({
      id: '', requestId: 'store-roundtrip', apiKey: 'stored-api-key', apiKeyId: 'key',
      apiId: 'api-a', endpointId: 'endpoint', userId: 'caller', amountUsdc: 30,
      statusCode: 429, timestamp: new Date().toISOString(),
    });
    assert.equal(didRecord, true);
    const events = await store.getEvents('stored-api-key');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.statusCode, 429);
    assert.equal(events[0]?.apiKey, 'stored-api-key');
  });

  test('backfill rejects duplicate request IDs and writes a report', async () => {
    await pool.query(`
      INSERT INTO usage_events_old (user_id, api_id, endpoint_id, api_key_id, developer_id, amount_usdc, request_id)
      VALUES ('user-b', 'api-b', 'endpoint-b', 'key-b', 'developer-b', 9, 'legacy-request')
    `);
    const reportDirectory = await mkdtemp(join(tmpdir(), 'usage-event-duplicates-'));
    const reportPath = join(reportDirectory, 'duplicates.csv');
    try {
      const script = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-usage-partitions.ts'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, DATABASE_URL: databaseUrl, DUPLICATE_REPORT: reportPath },
      });
      assert.notEqual(script.status, 0, script.stdout + script.stderr);
      const report = await readFile(reportPath, 'utf8');
      assert.match(report, /legacy-request/);
      assert.match(report, /developer-a/);
      assert.match(report, /developer-b/);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
