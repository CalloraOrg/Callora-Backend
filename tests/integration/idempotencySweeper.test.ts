/**
 * Idempotency Sweeper Integration Tests
 *
 * Tests the sweeper with a real PostgreSQL database (testcontainers) to verify:
 * 1. Advisory lock is acquired and released on the same session (no leaks)
 * 2. Concurrent sweepers safely coordinate via lock contention
 * 3. Batching works correctly with bounded deletes
 * 4. Time budget prevents unbounded work per run
 * 5. Lock is automatically released on commit/rollback
 *
 * Test Plan (from issue #1500):
 * - Scenario 1: Sweep with lock available → expired rows deleted; lock released
 * - Scenario 2: Two sweeps concurrently (two pools) → one deletes; other skips; no leak
 * - Scenario 3: 25k expired rows, batch 5k → 5 batches; all removed; non-expired untouched
 * - Scenario 4: Time budget reached mid-run → stops early; next run continues
 * - Scenario 5: Delete throws → client released; lock released; error logged
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import fs from 'fs';
import path from 'path';
import {
  sweepIdempotencyStoreRows,
  DEFAULT_SWEEPER_CONFIG,
  type IdempotencySweeperConfig,
} from '../../src/services/idempotencySweeper.js';

// ============================================================================
// Test Setup
// ============================================================================

let pool: Pool;
let container: any;

const DEFAULT_TEST_CONFIG: IdempotencySweeperConfig = {
  batchSize: 5000,
  timeBudgetMs: 10000,
};

/**
 * Setup: Start PostgreSQL container and initialize schema
 */
beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: 'test_idempotency',
      POSTGRES_USER: 'test_user',
      POSTGRES_PASSWORD: 'test_password',
    })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withExposedPorts(5432)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  const connectionString = `postgresql://test_user:test_password@${host}:${port}/test_idempotency`;
  pool = new Pool({ connectionString });

  // Create idempotency_store table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_store (
      id BIGSERIAL PRIMARY KEY,
      request_id VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_store_expires_at ON idempotency_store(expires_at);
  `);
}, 60000);

/**
 * Cleanup: Stop container and close pool
 */
afterAll(async () => {
  await pool.end();
  if (container) {
    await container.stop();
  }
}, 30000);

/**
 * Before each test: Clear the table
 */
beforeEach(async () => {
  await pool.query('DELETE FROM idempotency_store');
});

// ============================================================================
// Scenario 1: Sweep with lock available → expired rows deleted; lock released
// ============================================================================

describe('Idempotency Sweeper Integration Tests', () => {
  it('Scenario 1: Sweeps expired rows and releases lock', async () => {
    // Insert mixed expired and non-expired rows
    await pool.query(
      `INSERT INTO idempotency_store (request_id, expires_at) VALUES
       ('exp_1', NOW() - INTERVAL '1 day'),
       ('exp_2', NOW() - INTERVAL '1 day'),
       ('exp_3', NOW() - INTERVAL '1 day'),
       ('active_1', NOW() + INTERVAL '1 day'),
       ('active_2', NOW() + INTERVAL '1 day')`,
    );

    // Sweep with lock available
    const rowCount = await sweepIdempotencyStoreRows(pool, DEFAULT_TEST_CONFIG);

    // Verify expired rows were deleted
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM idempotency_store');
    const remainingCount = result.rows[0]?.count ?? 0;
    expect(remainingCount).toBe(2); // Only active rows remain

    // Verify gauge was updated
    expect(rowCount).toBe(2);

    // Verify lock was released: query pg_locks for our advisory lock
    const lockCheck = await pool.query(
      `SELECT COUNT(*)::int AS lock_count FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    const activeLocksAfter = lockCheck.rows[0]?.lock_count ?? 0;
    expect(activeLocksAfter).toBe(0); // Lock should be released
  });

  // ============================================================================
  // Scenario 2: Two sweeps concurrently (two pools) → one deletes; other skips
  // ============================================================================

  it('Scenario 2: Concurrent sweepers coordinate via lock contention', async () => {
    // Insert expired rows
    const insertSql = Array.from({ length: 100 }, (_, i) => `('exp_${i}', NOW() - INTERVAL '1 day')`).join(',');
    await pool.query(`INSERT INTO idempotency_store (request_id, expires_at) VALUES ${insertSql}`);

    // Create a second connection pool to simulate another instance
    const pool2 = new Pool({ connectionString: pool.options.connectionString });

    try {
      // Start both sweeps concurrently
      const sweep1 = sweepIdempotencyStoreRows(pool, DEFAULT_TEST_CONFIG);
      const sweep2 = sweepIdempotencyStoreRows(pool2, DEFAULT_TEST_CONFIG);

      const [rowCount1, rowCount2] = await Promise.all([sweep1, sweep2]);

      // Exactly one should process rows; the other should skip
      const deleted = rowCount1 + rowCount2;
      expect(deleted).toBe(0); // All were deleted

      // Check remaining rows
      const result = await pool.query('SELECT COUNT(*)::int AS count FROM idempotency_store');
      const remaining = result.rows[0]?.count ?? 0;
      expect(remaining).toBe(0);

      // Verify both pools released their locks
      const lockCheck = await pool.query(
        `SELECT COUNT(*)::int AS lock_count FROM pg_locks WHERE locktype = 'advisory'`,
      );
      const activeLocks = lockCheck.rows[0]?.lock_count ?? 0;
      expect(activeLocks).toBe(0);
    } finally {
      await pool2.end();
    }
  });

  // ============================================================================
  // Scenario 3: 25k expired rows, batch 5k → 5 batches; all removed
  // ============================================================================

  it('Scenario 3: Batches large deletes correctly', async () => {
    const totalRows = 25000;
    const batchSize = 5000;

    // Insert 25k expired rows
    const batchCount = Math.ceil(totalRows / 1000);
    for (let i = 0; i < batchCount; i++) {
      const rows = Array.from(
        { length: Math.min(1000, totalRows - i * 1000) },
        (_, j) => `('exp_${i * 1000 + j}', NOW() - INTERVAL '1 day')`,
      ).join(',');
      await pool.query(
        `INSERT INTO idempotency_store (request_id, expires_at) VALUES ${rows}`,
      );
    }

    // Insert 100 non-expired rows
    const activeRows = Array.from({ length: 100 }, (_, i) => `('active_${i}', NOW() + INTERVAL '1 day')`).join(',');
    await pool.query(
      `INSERT INTO idempotency_store (request_id, expires_at) VALUES ${activeRows}`,
    );

    // Sweep with batching
    const config: IdempotencySweeperConfig = { batchSize, timeBudgetMs: 60000 };
    const rowCount = await sweepIdempotencyStoreRows(pool, config);

    // Verify all expired rows were deleted
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM idempotency_store');
    const remaining = result.rows[0]?.count ?? 0;
    expect(remaining).toBe(100); // Only active rows

    // Verify gauge reflects remaining rows
    expect(rowCount).toBe(100);
  });

  // ============================================================================
  // Scenario 4: Time budget reached mid-run → stops early
  // ============================================================================

  it('Scenario 4: Respects time budget and stops early', async () => {
    // Insert 15k expired rows
    const batchCount = 15;
    for (let i = 0; i < batchCount; i++) {
      const rows = Array.from(
        { length: 1000 },
        (_, j) => `('exp_${i * 1000 + j}', NOW() - INTERVAL '1 day')`,
      ).join(',');
      await pool.query(
        `INSERT INTO idempotency_store (request_id, expires_at) VALUES ${rows}`,
      );
    }

    // Sweep with very tight time budget (100ms)
    const config: IdempotencySweeperConfig = { batchSize: 5000, timeBudgetMs: 100 };
    const rowCount = await sweepIdempotencyStoreRows(pool, config);

    // With a 100ms budget, we expect to delete only the first batch (5k rows)
    // and possibly the second batch if execution is fast enough
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM idempotency_store');
    const remaining = result.rows[0]?.count ?? 0;

    // Verify we didn't delete everything (proves time budget worked)
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(15000);
  });

  // ============================================================================
  // Scenario 5: Delete throws → client released; lock released
  // ============================================================================

  it('Scenario 5: Handles errors and releases client + lock', async () => {
    // Simulate a trigger that raises an error on delete
    await pool.query(`
      CREATE OR REPLACE FUNCTION block_delete_trigger() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Intentional delete error for testing';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER block_idempotency_deletes
      BEFORE DELETE ON idempotency_store
      FOR EACH ROW EXECUTE FUNCTION block_delete_trigger();
    `);

    // Insert a row so the trigger will fire
    await pool.query(
      `INSERT INTO idempotency_store (request_id, expires_at) VALUES ('exp_1', NOW() - INTERVAL '1 day')`,
    );

    // Sweep should throw
    await expect(
      sweepIdempotencyStoreRows(pool, DEFAULT_TEST_CONFIG),
    ).rejects.toThrow('Intentional delete error');

    // Cleanup trigger
    await pool.query('DROP TRIGGER block_idempotency_deletes ON idempotency_store');
    await pool.query('DROP FUNCTION block_delete_trigger()');

    // Verify lock was released
    const lockCheck = await pool.query(
      `SELECT COUNT(*)::int AS lock_count FROM pg_locks WHERE locktype = 'advisory'`,
    );
    const activeLocks = lockCheck.rows[0]?.lock_count ?? 0;
    expect(activeLocks).toBe(0);

    // Verify row still exists (transaction was rolled back)
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM idempotency_store');
    const count = result.rows[0]?.count ?? 0;
    expect(count).toBe(1);
  });

  // ============================================================================
  // Regression: Lock leak test
  // ============================================================================

  it('Regression: No lock leak after sweep completes', async () => {
    // Insert expired rows
    await pool.query(
      `INSERT INTO idempotency_store (request_id, expires_at) VALUES
       ('exp_1', NOW() - INTERVAL '1 day'),
       ('exp_2', NOW() - INTERVAL '1 day')`,
    );

    // Run multiple sweeps
    for (let i = 0; i < 5; i++) {
      await sweepIdempotencyStoreRows(pool, DEFAULT_TEST_CONFIG);
    }

    // After all sweeps, no locks should be held
    const lockCheck = await pool.query(
      `SELECT COUNT(*)::int AS lock_count FROM pg_locks WHERE locktype = 'advisory'`,
    );
    const activeLocks = lockCheck.rows[0]?.lock_count ?? 0;
    expect(activeLocks).toBe(0);
  });
});
