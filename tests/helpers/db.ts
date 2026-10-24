import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';

export function createTestDb() {
  const db = newDb();

  // Use a unique counter per database instance to avoid collisions
  let counter = Math.floor(Math.random() * 1000000);
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => {
      counter++;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, '0')}`;
    },
  });

  // pg-mem lacks to_char, and the idempotency lease SQL needs an explicit NOW() clock.
  db.public.registerFunction({
    name: 'to_char',
    args: [DataType.timestamp, DataType.text],
    returns: DataType.text,
    implementation: (value: Date) => value.toISOString().replace('T', ' ').replace('Z', '000'),
  });
  db.getSchema('pg_catalog').registerFunction(
    { name: 'now', args: [], returns: DataType.timestamptz, impure: true, implementation: () => new Date() },
    true,
  );

  db.public.none(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_address TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      api_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      prefix VARCHAR(16),
      revoked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Partial unique index: only active (non-revoked) keys must have unique prefixes.
    -- Revoked keys are excluded so a prefix can be reused after revocation.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_prefix_active
      ON api_keys (prefix)
      WHERE revoked = FALSE;

    CREATE TABLE IF NOT EXISTS usage_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_key_id UUID REFERENCES api_keys(id),
      called_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS idempotency_store (
      scope VARCHAR(255) NOT NULL DEFAULT 'anonymous',
      idempotency_key VARCHAR(255) NOT NULL,
      request_hash VARCHAR(64) NOT NULL,
      status VARCHAR(50) NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      response_headers JSONB,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      lease_expires_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Scoped uniqueness: the same key may be used by different principals.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_store_scope_key
      ON idempotency_store (scope, idempotency_key);
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    db,
    pool,
    async end() {
      await pool.end();
    },
  };
}

export async function resetTestDb(pool: any) {
  try {
    // Clear tables in reverse order of dependencies or use CASCADE
    // Using TRUNCATE with CASCADE is the most reliable way in PostgreSQL
    const tables = ['usage_logs', 'api_keys', 'users', 'idempotency_store'];
    
    for (const table of tables) {
      try {
        await pool.query(`TRUNCATE TABLE ${table} CASCADE`);
      } catch (err) {
        // If table doesn't exist, log and continue (some tests might have partial schema)
        console.warn(`Could not truncate table ${table}:`, (err as Error).message);
      }
    }
  } catch (error) {
    console.error('Failed to reset test database:', error);
    throw error;
  }
}

/**
 * Creates usage_events with the columns the billing write and read paths use:
 * migration 001 base columns, developer_id (0011), and the deduction lifecycle
 * columns (0027_usage_events_deduction_status).
 */
export async function createUsageEventsTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id BIGSERIAL PRIMARY KEY,
      developer_id VARCHAR(255) NOT NULL DEFAULT '',
      user_id VARCHAR(255) NOT NULL,
      api_id VARCHAR(255) NOT NULL,
      endpoint_id VARCHAR(255) NOT NULL,
      api_key_id VARCHAR(255) NOT NULL,
      amount_usdc NUMERIC(20, 0) NOT NULL CHECK (amount_usdc > 0),
      request_id VARCHAR(255) NOT NULL UNIQUE,
      stellar_tx_hash VARCHAR(64),
      deduction_status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (deduction_status IN ('pending', 'confirmed', 'voided')),
      resolved_at TIMESTAMP,
      resolution_reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}
