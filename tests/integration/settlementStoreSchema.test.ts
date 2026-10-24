import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import { PostgresSettlementStore } from '../../src/services/settlementStore.js';

const migrationPath = (filename: string) =>
  path.join(process.cwd(), 'migrations', filename);

async function runSql(pool: Pool, sql: string): Promise<void> {
  for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
}

describe('PostgresSettlementStore schema contract', () => {
  let container: Awaited<ReturnType<GenericContainer['start']>>;
  let pool: Pool;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: 'callora_test',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
      .start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'postgres',
      password: 'postgres',
      database: 'callora_test',
    });

    await pool.query(`
      CREATE TABLE settlements (
        id BIGSERIAL PRIMARY KEY,
        external_id VARCHAR(255) NOT NULL UNIQUE,
        developer_id VARCHAR(255) NOT NULL,
        amount_usdc DECIMAL(20, 7) NOT NULL,
        stellar_tx_hash VARCHAR(64),
        status VARCHAR(20) NOT NULL CONSTRAINT settlements_status_check
          CHECK (status IN ('pending', 'completed', 'failed')),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        CONSTRAINT check_completed_has_tx_hash CHECK (
          (status = 'completed' AND stellar_tx_hash IS NOT NULL) OR status != 'completed'
        )
      )
    `);
    await pool.query(`
      INSERT INTO settlements (external_id, developer_id, amount_usdc, status)
      VALUES ('preexisting', 'dev_1', 12.5, 'pending')
    `);
    await runSql(pool, readFileSync(migrationPath('0031_settlement_retry_policy.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('runs all store queries and enforces retry transitions against migrated schema', async () => {
    const store = new PostgresSettlementStore(pool);

    const backfill = await pool.query(
      `SELECT retry_count FROM settlements WHERE external_id = 'preexisting'`,
    );
    expect(backfill.rows[0].retry_count).toBe(0);

    await store.create({
      id: 'pending_retry',
      developerId: 'dev_1',
      amount: 15,
      status: 'pending',
      tx_hash: 'tx-pending',
      created_at: new Date().toISOString(),
    });
    await expect(store.getDeveloperSettlements('dev_1')).resolves.toHaveLength(2);
    await expect(store.getPendingSettlements()).resolves.toHaveLength(2);
    await expect(store.verifyLedger()).resolves.toMatchObject({ totalViolations: 0 });

    const retryAfter = new Date(Date.now() + 60_000).toISOString();
    await expect(store.scheduleRetry('pending_retry', retryAfter, 5)).resolves.toBe(true);
    const scheduled = await pool.query(
      `SELECT status, retry_count, retry_after FROM settlements WHERE external_id = 'pending_retry'`,
    );
    expect(scheduled.rows[0]).toMatchObject({ status: 'retryable', retry_count: 1 });
    expect(new Date(scheduled.rows[0].retry_after).getTime()).toBeGreaterThan(Date.now());
    const beforeDue = await store.getPendingSettlements();
    expect(beforeDue.map((row) => row.id)).not.toContain('pending_retry');

    await pool.query(
      `UPDATE settlements SET retry_after = NOW() - INTERVAL '1 second' WHERE external_id = 'pending_retry'`,
    );
    const afterDue = await store.getPendingSettlements();
    expect(afterDue.map((row) => row.id)).toContain('pending_retry');

    await pool.query(
      `UPDATE settlements SET retry_count = 5 WHERE external_id = 'pending_retry'`,
    );
    await expect(
      store.scheduleRetry('pending_retry', new Date().toISOString(), 5, 'retry limit reached'),
    ).resolves.toBe(true);
    const exhausted = await pool.query(
      `SELECT status, retry_count, retry_after, last_error FROM settlements WHERE external_id = 'pending_retry'`,
    );
    expect(exhausted.rows[0]).toMatchObject({
      status: 'failed',
      retry_count: 5,
      retry_after: null,
      last_error: 'retry limit reached',
    });

    await store.create({
      id: 'completed_retry',
      developerId: 'dev_1',
      amount: 1,
      status: 'completed',
      tx_hash: 'tx-completed',
      created_at: new Date().toISOString(),
    });
    await expect(
      store.scheduleRetry('completed_retry', new Date().toISOString(), 5),
    ).resolves.toBe(false);

    await store.updateStatus('pending_retry', 'failed');
    await store.updateStatus('pending_retry', 'completed', 'tx-recovered');
    await expect(store.verifyLedger()).resolves.toMatchObject({ totalViolations: 0 });

    await pool.query('SET enable_seqscan = off');
    const plan = await pool.query(`
      EXPLAIN SELECT id, external_id, developer_id, amount_usdc, status, stellar_tx_hash,
                     created_at, retry_after, retry_count
      FROM settlements
      WHERE status = 'pending'
      UNION ALL
      SELECT id, external_id, developer_id, amount_usdc, status, stellar_tx_hash,
             created_at, retry_after, retry_count
      FROM settlements
      WHERE status = 'retryable'
        AND retry_after IS NULL
      UNION ALL
      SELECT id, external_id, developer_id, amount_usdc, status, stellar_tx_hash,
             created_at, retry_after, retry_count
      FROM settlements
      WHERE status = 'retryable'
        AND retry_after <= NOW()
      ORDER BY created_at ASC, id ASC
    `);
    const explain = plan.rows.map((row) => Object.values(row).join(' ')).join('\n');
    console.info('Settlement pending query EXPLAIN:\n%s', explain);
    expect(explain).toContain('idx_settlements_retry_after');
  });

  it('rolls back retry columns and restores the original status constraint', async () => {
    await runSql(pool, readFileSync(migrationPath('0031_settlement_retry_policy.down.sql'), 'utf8'));

    const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'settlements'
    `);
    const columnNames = columns.rows.map((row) => row.column_name);
    expect(columnNames).not.toContain('retry_after');
    expect(columnNames).not.toContain('retry_count');
    expect(columnNames).not.toContain('last_error');
    await expect(
      pool.query(`
        INSERT INTO settlements (external_id, developer_id, amount_usdc, status)
        VALUES ('rollback_retryable', 'dev_1', 1, 'retryable')
      `),
    ).rejects.toThrow();
  });
});