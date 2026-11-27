import { newDb, DataType } from 'pg-mem';
import { Pool } from 'pg';
import { getRealPool, resetRealDb } from './pgReal.js';

export type TestDbMode = 'pg-mem' | 'real';

export interface CreateTestDbOptions {
  /**
   * Override the `TEST_DB` environment variable (`"pg-mem"` or `"real"`).
   */
  mode?: TestDbMode;
}

/**
 * Resolves whether `createTestDb` should use an in-memory `pg-mem` database
 * (default) or a real PostgreSQL `pg.Pool` (`TEST_DB=real`).
 */
export function resolveTestDbMode(
  options?: CreateTestDbOptions,
  env: NodeJS.ProcessEnv = process.env,
): TestDbMode {
  if (options?.mode) {
    return options.mode;
  }
  return env.TEST_DB?.trim().toLowerCase() === 'real' ? 'real' : 'pg-mem';
}

/**
 * Creates a test database handle.
 *
 * Defaults to an isolated in-memory `pg-mem` instance for fast local runs.
 * Set `TEST_DB=real` (alongside a PostgreSQL `DATABASE_URL`) or pass
 * `{ mode: 'real' }` to connect to a real PostgreSQL pool via `getRealPool()`.
 */
export function createTestDb(options?: CreateTestDbOptions) {
  const mode = resolveTestDbMode(options);

  if (mode === 'real') {
    const pool = getRealPool();
    if (!pool) {
      throw new Error(
        'TEST_DB=real requires DATABASE_URL to be set to a PostgreSQL connection string (postgres://... or postgresql://...).',
      );
    }

    return {
      db: null,
      pool,
      isReal: true as const,
      async end() {
        await pool.end();
      },
    };
  }

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
      idempotency_key VARCHAR(255) PRIMARY KEY,
      request_hash VARCHAR(64) NOT NULL,
      status VARCHAR(50) NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    db,
    pool,
    isReal: false as const,
    async end() {
      await pool.end();
    },
  };
}

export async function createSqliteTestDb() {
  const originalSqlitePath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = ':memory:';

  try {
    const [{ db, schema, sqlite, closeDb }, { resetDb }] =
      await Promise.all([
        import('../../src/db/index.js'),
        import('../../scripts/test-db.js'),
      ]);
    sqlite.exec(`
      CREATE TABLE developers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE,
        name TEXT,
        website TEXT,
        description TEXT,
        category TEXT,
        plan_overrides TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE apis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        developer_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        base_url TEXT NOT NULL,
        logo_url TEXT,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at INTEGER
      );
      CREATE TABLE api_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_id INTEGER NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        price_per_call_usdc TEXT NOT NULL DEFAULT '0.01',
        description TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    sqlite.pragma('foreign_keys = ON');
    return { db, schema, sqlite, resetDb, closeDb };
  } finally {
    if (originalSqlitePath === undefined) {
      delete process.env.SQLITE_PATH;
    } else {
      process.env.SQLITE_PATH = originalSqlitePath;
    }
  }
}

export async function resetTestDb(pool: any) {
  if (pool instanceof Pool) {
    await resetRealDb(pool);
    return;
  }

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