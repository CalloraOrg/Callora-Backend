import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { logger } from './logger.js';

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

/**
 * Compute the SHA-256 checksum of a file's content.
 * Returns the hex-encoded digest.
 */
export function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath, 'utf8');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Discover and validate up-migration files in the given directory.
 *
 * Rules enforced:
 *  - Only files ending in .up.sql or plain .sql (not .down.sql) are considered.
 *  - Every file must have a leading numeric prefix.
 *  - No two files may share the same numeric prefix (duplicate guard).
 *  - Prefixes must form a contiguous sequence with no gaps (ordering guard).
 *
 * Throws a descriptive Error on any violation so the process fails fast.
 */
export function discoverMigrations(dir: string): string[] {
  const files = readdirSync(dir).filter(
    f => (f.endsWith('.sql') || f.endsWith('.up.sql')) && !f.endsWith('.down.sql'),
  );

  // Parse and validate prefixes before sorting so invalid filenames never
  // participate in the numeric comparator.
  const migrations = files.map(filename => {
    const prefix = extractPrefix(filename);
    if (prefix === null) {
      throw new Error(
        `Migration file "${filename}" has no numeric prefix. ` +
          `Rename it to follow the NNNN_description.sql convention.`,
      );
    }
    return { filename, prefix };
  });

  // Reject duplicates before sorting so an ambiguous sequence cannot be applied.
  const seen = new Map<number, string>();
  for (const { filename, prefix } of migrations) {
    if (seen.has(prefix)) {
      throw new Error(
        `Duplicate migration prefix ${prefix}: "${seen.get(prefix)}" and "${filename}". ` +
          `Each migration must have a unique numeric prefix.`,
      );
    }
    seen.set(prefix, filename);
  }

  // Sort validated migrations by their numeric prefix.
  const sorted = migrations.sort((a, b) => a.prefix - b.prefix);

  // Gap guard — prefixes must be contiguous starting from the smallest value
  if (sorted.length > 0) {
    const first = sorted[0].prefix;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].prefix !== first + i) {
        throw new Error(
          `Gap detected in migration sequence: expected prefix ${first + i} after ${sorted[i - 1].prefix} ` +
            `but found ${sorted[i].prefix} ("${sorted[i].filename}"). ` +
            `Migrations must be numbered consecutively with no gaps.`,
        );
      }
    }
  }

  return sorted.map(({ filename }) => filename);
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

  // Add checksum column for databases created before the column existed
  const columns = db.prepare("PRAGMA table_info('_migrations')").all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'checksum')) {
    db.exec("ALTER TABLE _migrations ADD COLUMN checksum TEXT DEFAULT NULL");
    logger.info('Added checksum column to _migrations table');
  }
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

export function applyMigrations(db: Database.Database, migrationDir: string): void {
  ensureMigrationsTable(db);
  ensureSchemaVersionsTable(db);
  const available = discoverMigrations(migrationDir);

  for (const filename of available) {
    const isExecuted = db.prepare('SELECT id FROM _migrations WHERE name = ?').get(filename);
    if (isExecuted) continue;

    logger.info('Running migration: ' + filename);
    const sql = readFileSync(path.join(migrationDir, filename), 'utf8');
    const checksum = computeChecksum(path.join(migrationDir, filename));
    const prefix = extractPrefix(filename)!;

    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(filename, checksum);
      db.prepare(
        'INSERT INTO schema_versions (version, filename, checksum) VALUES (?, ?, ?)',
      ).run(prefix, filename, checksum);
    });

    run();
    logger.info('Finished ' + filename + ' (checksum: ' + checksum.slice(0, 12) + '...)');
  }
}

/**
 * Validates that all migrations present on disk have been applied to the database.
 * Throws an error if there are pending migrations, ensuring the app does not
 * start with an expected schema drift.
 */
export function validateSchemaState(db: Database.Database, migrationDir: string): void {
  ensureMigrationsTable(db);
  const available = discoverMigrations(migrationDir);
  const unapplied: string[] = [];

  for (const filename of available) {
    const isExecuted = db.prepare('SELECT id FROM _migrations WHERE name = ?').get(filename);
    if (!isExecuted) {
      unapplied.push(filename);
    }
  }

  if (unapplied.length > 0) {
    throw new Error(
      `Schema validation failed. The following migrations have not been applied:\n` +
      unapplied.map(f => `  - ${f}`).join('\n') +
      `\nPlease run migrations before starting the application.`
    );
  }
}

// Guard: only run the migration logic when executed as a script, not when imported.
if (require.main === module) {
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
