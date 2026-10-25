/**
 * Tests for the pure helpers exported from src/migrate.ts (extractPrefix,
 * computeChecksum). Migration planning and ledger checks run against real
 * SQLite in tests/integration/sqlite-migrations.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractPrefix, computeChecksum } from './migrate.js';
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
// computeChecksum
// ---------------------------------------------------------------------------

describe('computeChecksum', () => {
  it('produces a stable SHA-256 digest for the tracked schema_versions SQL asset', () => {
    const assetPath = path.join(process.cwd(), 'drizzle', 'schema-versions.sql');

    expect(fs.existsSync(assetPath)).toBe(true);
    expect(computeChecksum(assetPath)).toMatch(/^[a-f0-9]{64}$/);
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
