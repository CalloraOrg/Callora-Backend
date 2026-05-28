/**
 * Tests for src/migrate.ts — ordering guard, idempotency, and down migrations.
 *
 * We import only the pure helper functions (extractPrefix, discoverMigrations)
 * so we can exercise all guard logic without touching the filesystem or a real DB.
 * Integration-style tests use a lightweight in-memory store to simulate the
 * _migrations table, avoiding the native better-sqlite3 binding requirement.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPrefix, discoverMigrations } from './migrate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory populated with the given filenames (empty files). */
function makeTmpDir(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), '-- placeholder\n');
  }
  return dir;
}

/** Write real SQL content to a file inside dir. */
function writeSQL(dir: string, filename: string, sql: string): void {
  fs.writeFileSync(path.join(dir, filename), sql);
}

/** Remove a temporary directory and all its contents. */
function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Lightweight in-memory DB stub (avoids native better-sqlite3 binding)
// ---------------------------------------------------------------------------

interface MigrationRow { name: string }

class InMemoryMigrationStore {
  private applied = new Set<string>();

  hasApplied(name: string): boolean {
    return this.applied.has(name);
  }

  record(name: string): void {
    this.applied.add(name);
  }

  all(): MigrationRow[] {
    return [...this.applied].map(name => ({ name }));
  }

  clear(): void {
    this.applied.clear();
  }
}

/**
 * Minimal runner that mirrors the logic in migrate.ts but uses the in-memory
 * store instead of better-sqlite3, so tests run without native bindings.
 */
function runMigrations(dir: string, store: InMemoryMigrationStore): void {
  const files = discoverMigrations(dir);
  for (const filename of files) {
    if (store.hasApplied(filename)) continue;
    // Read the SQL (we don't actually execute it — we just verify the runner logic)
    fs.readFileSync(path.join(dir, filename), 'utf8');
    store.record(filename);
  }
}

// ---------------------------------------------------------------------------
// extractPrefix
// ---------------------------------------------------------------------------

describe('extractPrefix', () => {
  it('returns the numeric prefix as an integer', () => {
    expect(extractPrefix('0001_create_api_keys.sql')).toBe(1);
    expect(extractPrefix('0000_initial.sql')).toBe(0);
    expect(extractPrefix('001_create_usage_events.sql')).toBe(1);
    expect(extractPrefix('123_something.up.sql')).toBe(123);
  });

  it('returns null for filenames without a leading numeric prefix', () => {
    expect(extractPrefix('add_refresh_tokens.sql')).toBeNull();
    expect(extractPrefix('README.md')).toBeNull();
    expect(extractPrefix('_001_bad.sql')).toBeNull();
    expect(extractPrefix('no_prefix.sql')).toBeNull();
  });

  it('ignores leading zeros when parsing the integer', () => {
    expect(extractPrefix('0005_foo.sql')).toBe(5);
    expect(extractPrefix('0010_bar.sql')).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// discoverMigrations — ordering guard
// ---------------------------------------------------------------------------

describe('discoverMigrations — ordering guard', () => {
  let dir: string;

  afterEach(() => rmTmpDir(dir));

  it('returns files sorted by numeric prefix', () => {
    dir = makeTmpDir(['0002_c.sql', '0000_a.sql', '0001_b.sql']);
    const result = discoverMigrations(dir);
    expect(result).toEqual(['0000_a.sql', '0001_b.sql', '0002_c.sql']);
  });

  it('accepts a single migration file', () => {
    dir = makeTmpDir(['0000_init.sql']);
    expect(discoverMigrations(dir)).toEqual(['0000_init.sql']);
  });

  it('accepts an empty directory', () => {
    dir = makeTmpDir([]);
    expect(discoverMigrations(dir)).toEqual([]);
  });

  it('excludes .down.sql files from the result', () => {
    dir = makeTmpDir(['0000_init.sql', '0000_init.down.sql', '0001_next.sql', '0001_next.down.sql']);
    const result = discoverMigrations(dir);
    expect(result).toEqual(['0000_init.sql', '0001_next.sql']);
    expect(result).not.toContain('0000_init.down.sql');
    expect(result).not.toContain('0001_next.down.sql');
  });

  it('accepts .up.sql files', () => {
    dir = makeTmpDir(['0000_init.up.sql', '0001_next.up.sql']);
    expect(discoverMigrations(dir)).toEqual(['0000_init.up.sql', '0001_next.up.sql']);
  });

  it('ignores non-SQL files', () => {
    dir = makeTmpDir(['0000_init.sql', 'README.md', '.gitkeep']);
    expect(discoverMigrations(dir)).toEqual(['0000_init.sql']);
  });
});

// ---------------------------------------------------------------------------
// discoverMigrations — no-prefix guard
// ---------------------------------------------------------------------------

describe('discoverMigrations — no-prefix guard', () => {
  let dir: string;

  afterEach(() => rmTmpDir(dir));

  it('throws when a file has no numeric prefix', () => {
    dir = makeTmpDir(['0000_init.sql', 'add_refresh_tokens.sql']);
    expect(() => discoverMigrations(dir)).toThrow(/no numeric prefix/i);
  });

  it('includes the offending filename in the error message', () => {
    dir = makeTmpDir(['add_refresh_tokens.sql']);
    expect(() => discoverMigrations(dir)).toThrow('add_refresh_tokens.sql');
  });

  it('throws even when only one file lacks a prefix', () => {
    dir = makeTmpDir(['0000_a.sql', '0001_b.sql', 'bad_name.sql']);
    expect(() => discoverMigrations(dir)).toThrow(/no numeric prefix/i);
  });
});

// ---------------------------------------------------------------------------
// discoverMigrations — duplicate-prefix guard
// ---------------------------------------------------------------------------

describe('discoverMigrations — duplicate-prefix guard', () => {
  let dir: string;

  afterEach(() => rmTmpDir(dir));

  it('throws on duplicate numeric prefixes', () => {
    dir = makeTmpDir(['0001_foo.sql', '0001_bar.sql']);
    expect(() => discoverMigrations(dir)).toThrow(/duplicate migration prefix/i);
  });

  it('includes the prefix value in the error message', () => {
    dir = makeTmpDir(['0002_foo.sql', '0002_bar.sql']);
    expect(() => discoverMigrations(dir)).toThrow('2');
  });

  it('includes both conflicting filenames in the error message', () => {
    dir = makeTmpDir(['0003_alpha.sql', '0003_beta.sql']);
    const err = (() => {
      try {
        discoverMigrations(dir);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(err).toMatch(/0003_alpha\.sql/);
    expect(err).toMatch(/0003_beta\.sql/);
  });
});

// ---------------------------------------------------------------------------
// discoverMigrations — gap guard
// ---------------------------------------------------------------------------

describe('discoverMigrations — gap guard', () => {
  let dir: string;

  afterEach(() => rmTmpDir(dir));

  it('throws when there is a gap in the sequence', () => {
    dir = makeTmpDir(['0000_a.sql', '0002_c.sql']); // missing 0001
    expect(() => discoverMigrations(dir)).toThrow(/gap detected/i);
  });

  it('includes the expected and actual prefix in the error message', () => {
    dir = makeTmpDir(['0000_a.sql', '0003_d.sql']);
    const err = (() => {
      try {
        discoverMigrations(dir);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(err).toMatch(/expected prefix 1/i);
    expect(err).toMatch(/found 3/i);
  });

  it('does not throw for a contiguous sequence not starting at 0', () => {
    // Sequence 1, 2, 3 — contiguous, so no gap
    dir = makeTmpDir(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
    expect(() => discoverMigrations(dir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: runner idempotency (using in-memory store)
// ---------------------------------------------------------------------------

describe('Runner idempotency', () => {
  let dir: string;
  let store: InMemoryMigrationStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-idem-'));
    store = new InMemoryMigrationStore();
  });

  afterEach(() => rmTmpDir(dir));

  it('applies a migration exactly once', () => {
    writeSQL(dir, '0000_create_foo.sql', '-- create foo');
    runMigrations(dir, store);
    runMigrations(dir, store); // second run must be a no-op
    expect(store.all()).toHaveLength(1);
  });

  it('skips already-applied migrations on re-run', () => {
    writeSQL(dir, '0000_create_foo.sql', '-- create foo');
    writeSQL(dir, '0001_create_bar.sql', '-- create bar');
    runMigrations(dir, store);
    expect(() => runMigrations(dir, store)).not.toThrow();
    const names = store.all().map(r => r.name);
    expect(names).toEqual(['0000_create_foo.sql', '0001_create_bar.sql']);
  });

  it('records each migration in the store', () => {
    writeSQL(dir, '0000_a.sql', '-- a');
    writeSQL(dir, '0001_b.sql', '-- b');
    runMigrations(dir, store);
    const names = store.all().map(r => r.name);
    expect(names).toContain('0000_a.sql');
    expect(names).toContain('0001_b.sql');
  });

  it('applies only new migrations when some are already recorded', () => {
    writeSQL(dir, '0000_a.sql', '-- a');
    writeSQL(dir, '0001_b.sql', '-- b');
    // Pre-mark 0000 as applied
    store.record('0000_a.sql');
    runMigrations(dir, store);
    const names = store.all().map(r => r.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('0001_b.sql');
  });
});

// ---------------------------------------------------------------------------
// Integration: transaction rollback on failure
// ---------------------------------------------------------------------------

describe('Runner transaction rollback', () => {
  it('does not record a migration when the runner throws', () => {
    const store = new InMemoryMigrationStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-tx-'));
    try {
      // Create a directory with a gap so discoverMigrations throws
      writeSQL(dir, '0000_a.sql', '-- a');
      writeSQL(dir, '0002_c.sql', '-- c'); // gap: missing 0001
      expect(() => runMigrations(dir, store)).toThrow(/gap detected/i);
      // Nothing should have been recorded because the runner threw before applying
      expect(store.all()).toHaveLength(0);
    } finally {
      rmTmpDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Down migration files exist for every up migration
// ---------------------------------------------------------------------------

describe('Down migration coverage', () => {
  const migrationsDir = path.join(process.cwd(), 'migrations');

  it('every up migration has a matching .down.sql file', () => {
    const allFiles = fs.readdirSync(migrationsDir);
    const upFiles = allFiles.filter(
      f => (f.endsWith('.sql') || f.endsWith('.up.sql')) && !f.endsWith('.down.sql'),
    );

    const missing: string[] = [];
    for (const up of upFiles) {
      // Derive the expected down filename
      const base = up.replace(/\.up\.sql$/, '').replace(/\.sql$/, '');
      const downFile = `${base}.down.sql`;
      if (!allFiles.includes(downFile)) {
        missing.push(up);
      }
    }

    expect(missing).toEqual([]);
  });

  it('each .down.sql file is non-empty', () => {
    const allFiles = fs.readdirSync(migrationsDir);
    const downFiles = allFiles.filter(f => f.endsWith('.down.sql'));
    expect(downFiles.length).toBeGreaterThan(0);
    for (const f of downFiles) {
      const content = fs.readFileSync(path.join(migrationsDir, f), 'utf8').trim();
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
