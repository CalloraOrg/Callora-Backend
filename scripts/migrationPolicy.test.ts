import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { validateMigrationLayout } from './migrationPolicy.js';

function withMigrations(files: Record<string, string>, test: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callora-migrations-'));
  try {
    Object.entries(files).forEach(([name, body]) => writeFileSync(path.join(dir, name), body));
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration layout policy', () => {
  it('accepts a new contiguous migration after the frozen history', () => {
    withMigrations({ '0022_add_limits.sql': 'CREATE TABLE limits (id INTEGER);' }, (dir) => {
      expect(validateMigrationLayout(dir)).toEqual([]);
    });
  });

  it('rejects duplicate, gapped, and unnumbered new migrations', () => {
    withMigrations({
      '0022_first.sql': 'SELECT 1;',
      '0022_second.sql': 'SELECT 1;',
      '0024_gap.sql': 'SELECT 1;',
      'new_feature.sql': 'SELECT 1;',
    }, (dir) => {
      const errors = validateMigrationLayout(dir).join('\n');
      expect(errors).toContain('Duplicate new migration prefix 22');
      expect(errors).toContain('new_feature.sql');
      expect(errors).toContain('sequence must continue');
    });
  });

  it('requires an issue marker for destructive SQL', () => {
    withMigrations({ '0022_remove_legacy.sql': 'DROP TABLE legacy;' }, (dir) => {
      expect(validateMigrationLayout(dir).join('\n')).toContain('destructive-approved');
    });
    withMigrations({ '0022_remove_legacy.sql': '-- destructive-approved: #1148\nDROP TABLE legacy;' }, (dir) => {
      expect(validateMigrationLayout(dir)).toEqual([]);
    });
  });
});
