import path from 'path';
import { Pool } from 'pg';
import {
  applyPostgresMigrations,
  type ApplyPostgresMigrationsResult,
} from '../../src/migrate.js';

const PRESERVED_METADATA_TABLES = new Set([
  'schema_versions',
  '_migrations',
  '_prisma_migrations',
]);

/**
 * Returns true when the given connection string targets PostgreSQL.
 */
export function isPostgresUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^postgres(?:ql)?:\/\//i.test(url.trim());
}

/**
 * Returns true when `DATABASE_URL` points to a PostgreSQL instance.
 */
export function hasRealPostgres(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPostgresUrl(env.DATABASE_URL);
}

/**
 * Creates and returns a real `pg.Pool` when `DATABASE_URL` (or the provided
 * connection string) points to PostgreSQL; otherwise returns `undefined`.
 */
export function getRealPool(
  connectionString: string | undefined = process.env.DATABASE_URL,
): Pool | undefined {
  if (!isPostgresUrl(connectionString)) {
    return undefined;
  }
  return new Pool({ connectionString: connectionString.trim() });
}

/**
 * Jest `describe` wrapper that skips the suite cleanly when `DATABASE_URL`
 * does not point to PostgreSQL.
 */
export function describeIfRealPostgres(name: string, fn: () => void): void {
  if (hasRealPostgres()) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

/**
 * Heuristic filter to skip SQLite-only migrations in the shared `migrations/`
 * directory when applying migrations to real PostgreSQL.
 */
export function isPostgresCompatibleMigration(
  _filename: string,
  sql: string,
): boolean {
  const dialectMatch = sql.match(/--\s*dialect:\s*(sqlite|postgres|both)\b/i);
  if (dialectMatch && dialectMatch[1].toLowerCase() === 'sqlite') {
    return false;
  }

  // Detect SQLite-only syntax that PostgreSQL rejects.
  if (
    /`[^`]+`/.test(sql) ||
    /\bAUTOINCREMENT\b/i.test(sql) ||
    /\bunixepoch\s*\(/i.test(sql) ||
    /\bstrftime\s*\(/i.test(sql) ||
    /^\s*PRAGMA\b/im.test(sql)
  ) {
    return false;
  }

  return true;
}

/**
 * Applies ordered `.sql` up-migrations to the provided PostgreSQL pool using
 * the migration runner logic in `src/migrate.ts`. `.down.sql` files are never
 * applied.
 */
export async function applyMigrations(
  pool: Pool,
  migrationDir: string = path.join(process.cwd(), 'migrations'),
): Promise<ApplyPostgresMigrationsResult> {
  return applyPostgresMigrations(pool, migrationDir, {
    filter: isPostgresCompatibleMigration,
  });
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Truncates all tables in the `public` schema with `RESTART IDENTITY CASCADE`,
 * leaving migration metadata tables (`schema_versions`, `_migrations`,
 * `_prisma_migrations`) intact. Safe to call repeatedly.
 */
export async function resetRealDb(pool: Pool): Promise<void> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );

  const tablesToTruncate = result.rows
    .map(row => row.tablename)
    .filter(name => !PRESERVED_METADATA_TABLES.has(name));

  if (tablesToTruncate.length === 0) {
    return;
  }

  const quoted = tablesToTruncate.map(name => `public.${quoteIdent(name)}`).join(', ');
  await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
