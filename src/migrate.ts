import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import { getMigrationDialect } from './db/demo.js';
import { LEGACY_MAX_PREFIX, isUpMigration, validateMigrationLayout } from './db/migrationLayout.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract the numeric prefix from a migration filename.
 * Accepts formats like: 0001_foo.up.sql, 001_foo.sql, 0000_foo.sql
 * Returns null for filenames without a leading numeric prefix.
 */
export function extractPrefix(filename: string): number | null {
  const match = filename.match(/^(\d+)_/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Compute the SHA-256 checksum of a file's content.
 * Returns the hex-encoded digest.
 */
export function computeChecksum(filePath: string): string {
  return checksumOf(readFileSync(filePath, 'utf8'));
}

export interface MigrationPlanEntry {
  filename: string;
  /** Numeric prefix. Legacy versions (<= LEGACY_MAX_PREFIX) may be shared by several files. */
  version: number;
  checksum: string;
  sql: string;
  /**
   * Legacy entries are authoritative in `_migrations` only. From version 22 on,
   * each entry also has exactly one `schema_versions` row.
   */
  legacy: boolean;
}

/**
 * The SQLite migration plan for `migrationDir`.
 *
 *  1. The global layout policy runs over every forward file first, so a
 *     Postgres-only gap cannot hide a layout violation.
 *  2. Only numbered forward files whose dialect is not `postgres` are kept.
 *     Unnumbered legacy helper SQL is unversioned and is never applied.
 *  3. Entries are ordered by (version, filename), never by directory order.
 */
export function planSqliteMigrations(migrationDir: string): MigrationPlanEntry[] {
  const violations = validateMigrationLayout(migrationDir);
  if (violations.length > 0) {
    throw new Error(`Migration layout policy failed:\n  - ${violations.join('\n  - ')}`);
  }

  const plan: MigrationPlanEntry[] = [];
  for (const filename of readdirSync(migrationDir).filter(isUpMigration)) {
    const version = extractPrefix(filename);
    if (version === null) continue;
    const sql = readFileSync(path.join(migrationDir, filename), 'utf8');
    if (getMigrationDialect(filename, sql) === 'postgres') continue;
    plan.push({ filename, version, checksum: checksumOf(sql), sql, legacy: version <= LEGACY_MAX_PREFIX });
  }
  return plan.sort(
    (a, b) =>
      a.version - b.version || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// Runner — only executes when this file is run directly (not imported in tests)
// ---------------------------------------------------------------------------

// Use process.cwd() to avoid the __filename SyntaxError in Jest
const rootDir = process.cwd();
const migrationDir = path.join(rootDir, 'migrations');
const dbPath = path.join(rootDir, 'database.db');

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT DEFAULT NULL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Ensure the schema_versions table exists.
 * This is the public single-source-of-truth table for migration tracking.
 * Created by migration 0013 but also created here as a safety net.
 */
function ensureSchemaVersionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version     INTEGER NOT NULL UNIQUE,
      filename    TEXT    NOT NULL,
      checksum    TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      executed_by TEXT    DEFAULT NULL
    )
  `);
}

interface RecordedHistory {
  /** `_migrations` rows: filename -> checksum (null when the row predates checksums). */
  ledger: Map<string, string | null>;
  /** `schema_versions` rows. */
  versions: Array<{ version: number; filename: string; checksum: string }>;
  /** Tables exist besides the two bookkeeping tables. */
  hasUntrackedTables: boolean;
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Read-only: never creates or alters bookkeeping tables. */
function readHistory(db: Database.Database): RecordedHistory {
  const ledger = new Map<string, string | null>();
  if (hasTable(db, '_migrations')) {
    const columns = db.prepare("PRAGMA table_info('_migrations')").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'checksum')) {
      throw new Error('_migrations has no checksum column; migration history cannot be verified.');
    }
    const rows = db.prepare('SELECT name, checksum FROM _migrations').all() as Array<{
      name: string;
      checksum: string | null;
    }>;
    for (const row of rows) ledger.set(row.name, row.checksum);
  }
  const versions = hasTable(db, 'schema_versions')
    ? (db.prepare('SELECT version, filename, checksum FROM schema_versions').all() as RecordedHistory['versions'])
    : [];
  const untracked = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
        "AND name NOT IN ('_migrations', 'schema_versions') LIMIT 1",
    )
    .get();
  return { ledger, versions, hasUntrackedTables: untracked !== undefined };
}

/**
 * Checks recorded history against the plan and returns the unapplied entries.
 * Fails closed on anything the plan cannot explain. Never rewrites, reorders,
 * or backfills recorded rows.
 */
function assertKnownHistory(plan: MigrationPlanEntry[], history: RecordedHistory): MigrationPlanEntry[] {
  const byName = new Map(plan.map((entry) => [entry.filename, entry]));
  const incoherent = (detail: string) =>
    new Error(
      `Migration history is not coherent with the SQLite migration plan: ${detail}. ` +
        'Refusing to continue; a maintainer-approved recovery plan is required.',
    );

  for (const [name, checksum] of history.ledger) {
    const entry = byName.get(name);
    if (!entry) throw incoherent(`_migrations records "${name}", which is not in the plan`);
    if (checksum !== entry.checksum) {
      throw incoherent(`_migrations checksum for "${name}" is ${checksum ?? 'missing'}, expected ${entry.checksum}`);
    }
  }

  for (const row of history.versions) {
    const entry = byName.get(row.filename);
    if (!entry || !history.ledger.has(row.filename) || entry.version !== row.version || entry.checksum !== row.checksum) {
      throw incoherent(`schema_versions row ${row.version} "${row.filename}" is not a recorded planned migration`);
    }
  }

  const applied = plan.filter((entry) => history.ledger.has(entry.filename));
  if (applied.length === 0 && history.hasUntrackedTables) {
    throw incoherent('the database has tables but no _migrations rows');
  }
  for (const entry of applied) {
    if (!entry.legacy && !history.versions.some((row) => row.filename === entry.filename)) {
      throw incoherent(`"${entry.filename}" is recorded in _migrations but has no schema_versions row`);
    }
  }

  const firstPending = plan.findIndex((entry) => !history.ledger.has(entry.filename));
  if (firstPending !== -1 && plan.slice(firstPending + 1).some((entry) => history.ledger.has(entry.filename))) {
    throw incoherent(`"${plan[firstPending].filename}" is unapplied but a later migration is recorded`);
  }

  return plan.filter((entry) => !history.ledger.has(entry.filename));
}

export function applyMigrations(db: Database.Database, migrationDir: string): void {
  const pending = assertKnownHistory(planSqliteMigrations(migrationDir), readHistory(db));
  ensureMigrationsTable(db);
  ensureSchemaVersionsTable(db);

  for (const entry of pending) {
    logger.info('Running migration: ' + entry.filename);

    const run = db.transaction(() => {
      db.exec(entry.sql);
      db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(entry.filename, entry.checksum);
      if (!entry.legacy) {
        db.prepare(
          'INSERT INTO schema_versions (version, filename, checksum) VALUES (?, ?, ?)',
        ).run(entry.version, entry.filename, entry.checksum);
      }
    });

    run();
    logger.info('Finished ' + entry.filename + ' (checksum: ' + entry.checksum.slice(0, 12) + '...)');
  }
}

/**
 * Production check (read-only): every planned SQLite migration must be recorded
 * with its checksum in `_migrations`, and every version from 22 on must also have
 * its `schema_versions` row. Table presence alone is never sufficient.
 */
export function validateSchemaState(db: Database.Database, migrationDir: string): void {
  const pending = assertKnownHistory(planSqliteMigrations(migrationDir), readHistory(db));
  if (pending.length > 0) {
    throw new Error(
      `Schema validation failed. The following migrations have not been applied:\n` +
      pending.map((entry) => `  - ${entry.filename}`).join('\n') +
      `\nPlease run migrations before starting the application.`
    );
  }
}

// Guard: only run the migration logic when executed as a script, not when imported.
//
// The project is ESM ("type": "module" in package.json), so `require.main`
// does not exist: importing this module threw
// `ReferenceError: require is not defined in ES module scope` and the server
// could not start. The argv check mirrors the CommonJS/Jest-compatible guard
// already used in `src/index.ts`.
const isDirectExecution =
  !!process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (isDirectExecution) {
  const db = new Database(dbPath);
  try {
    applyMigrations(db, migrationDir);
  } catch (error) {
    logger.error('Migration runner failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}
