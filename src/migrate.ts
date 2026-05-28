import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract the numeric prefix from a migration filename.
 * Accepts formats like: 0001_foo.up.sql, 001_foo.sql, 0000_foo.sql
 * Returns null for filenames without a leading numeric prefix (e.g. add_refresh_tokens.sql).
 */
export function extractPrefix(filename: string): number | null {
  const match = filename.match(/^(\d+)_/);
  if (!match) return null;
  return parseInt(match[1], 10);
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

  // Validate that every file has a numeric prefix
  for (const f of files) {
    if (extractPrefix(f) === null) {
      throw new Error(
        `Migration file "${f}" has no numeric prefix. ` +
          `Rename it to follow the NNNN_description.sql convention.`,
      );
    }
  }

  // Sort by numeric prefix so we process in order
  const sorted = [...files].sort((a, b) => extractPrefix(a)! - extractPrefix(b)!);

  // Duplicate-prefix guard
  const seen = new Map<number, string>();
  for (const f of sorted) {
    const prefix = extractPrefix(f)!;
    if (seen.has(prefix)) {
      throw new Error(
        `Duplicate migration prefix ${prefix}: "${seen.get(prefix)}" and "${f}". ` +
          `Each migration must have a unique numeric prefix.`,
      );
    }
    seen.set(prefix, f);
  }

  // Gap guard — prefixes must be contiguous starting from the smallest value
  const prefixes = sorted.map(f => extractPrefix(f)!);
  const first = prefixes[0];
  for (let i = 1; i < prefixes.length; i++) {
    if (prefixes[i] !== first + i) {
      throw new Error(
        `Gap detected in migration sequence: expected prefix ${first + i} after ${prefixes[i - 1]} ` +
          `but found ${prefixes[i]} ("${sorted[i]}"). ` +
          `Migrations must be numbered consecutively with no gaps.`,
      );
    }
  }

  return sorted;
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
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Guard: only run the migration logic when executed as a script, not when imported.
// In Jest, require.main is undefined; when run via tsx/node, require.main === module.
if (require.main === module) {
  const db = new Database(dbPath);
  try {
    ensureMigrationsTable(db);
    const available = discoverMigrations(migrationDir);

    for (const filename of available) {
      const isExecuted = db.prepare('SELECT id FROM _migrations WHERE name = ?').get(filename);
      if (isExecuted) continue; // idempotent: skip already-applied migrations

      logger.info(`🚀 Running migration: ${filename}`);
      const sql = readFileSync(path.join(migrationDir, filename), 'utf8');

      // Wrap in a transaction so a partial failure leaves the DB unchanged
      const run = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
      });

      run();
      logger.info(`✅ Finished ${filename}`);
    }
  } catch (error) {
    logger.error('❌ Migration runner failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}
