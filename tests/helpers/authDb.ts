import { readFileSync } from 'node:fs';
import { DataType } from 'pg-mem';
import { createTestDb } from './db.js';

/** Auth tests use the current idempotency schema without a Docker service. */
export async function createAuthTestDb() {
  const context = createTestDb();
  context.db.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => Array.from(value).length,
  });
  // As in the idempotency middleware tests, pg-mem only needs a timestamp
  // presentation shim; lease comparisons and mutations still execute as SQL.
  context.db.public.registerFunction({
    name: 'to_char',
    args: [DataType.timestamp, DataType.text],
    returns: DataType.text,
    implementation: (value: Date) =>
      value.toISOString().replace('T', ' ').replace('Z', '000'),
  });
  // pg-mem treats CURRENT_TIMESTAMP as timestamp without time zone, unlike
  // PostgreSQL. Its NOW() has the correct timestamptz type. Keep the production
  // column types and execute the equivalent expression in this adapter only.
  const query = context.pool.query.bind(context.pool);
  context.pool.query = (sql: string, values?: unknown[]) =>
    query(sql.replace(/\bCURRENT_TIMESTAMP\b/gi, 'NOW()'), values);
  try {
    for (const migration of [
      '0025_idempotency_store_scope.sql',
      '0028_idempotency_lease.sql',
    ]) {
      await context.pool.query(readFileSync(`migrations/${migration}`, 'utf8'));
    }
    return context;
  } catch (error) {
    await context.end();
    throw error;
  }
}
