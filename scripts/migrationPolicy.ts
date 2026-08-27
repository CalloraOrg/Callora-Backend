import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Historical migrations use two numbering schemes and contain deployed
// duplicate prefixes. They are frozen; new migrations begin at 0022.
const LEGACY_MAX_PREFIX = 21;
const LEGACY_UNNUMBERED = new Set([
  'add_refresh_token_family.sql', 'add_refresh_tokens.down.sql', 'add_refresh_tokens.sql',
  'auth_index.down.sql', 'auth_index.sql', 'billing_index.down.sql', 'billing_index.sql',
  'credits_index.down.sql', 'credits_index.sql',
]);

function prefix(filename: string): number | null {
  const match = filename.match(/^(\d{4})_/);
  return match ? Number(match[1]) : null;
}

function isUpMigration(filename: string): boolean {
  return (filename.endsWith('.sql') || filename.endsWith('.up.sql')) && !filename.endsWith('.down.sql');
}

/** Return policy violations without mutating the migration directory. */
export function validateMigrationLayout(migrationDir: string): string[] {
  const files = readdirSync(migrationDir).filter(isUpMigration);
  const violations: string[] = [];
  const future = files.filter((file) => {
    const number = prefix(file);
    return number !== null ? number > LEGACY_MAX_PREFIX : !LEGACY_UNNUMBERED.has(file);
  });

  for (const file of future) {
    const number = prefix(file);
    if (number === null) {
      violations.push(`Migration file "${file}" must use NNNN_description.sql naming.`);
      continue;
    }
    if (!/^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/.test(file) && !/^\d{4}_[a-z0-9][a-z0-9_-]*\.up\.sql$/.test(file)) {
      violations.push(`Migration file "${file}" must use four digits and a lowercase description.`);
    }
    const content = readFileSync(path.join(migrationDir, file), 'utf8');
    if (/\b(?:DROP|TRUNCATE)\b|\bDELETE\s+FROM\b/i.test(content) && !/^\s*--\s*destructive-approved:\s*#[0-9]+\s*$/im.test(content)) {
      violations.push(`Destructive migration "${file}" requires -- destructive-approved: #<issue>.`);
    }
  }

  const numbers = future.map(prefix).filter((number): number is number => number !== null).sort((a, b) => a - b);
  for (let index = 0; index < numbers.length; index += 1) {
    const expected = LEGACY_MAX_PREFIX + 1 + index;
    if (numbers[index] !== expected) {
      violations.push(`Migration sequence must continue at ${String(expected).padStart(4, '0')}; found ${String(numbers[index]).padStart(4, '0')}.`);
      break;
    }
    if (index > 0 && numbers[index] === numbers[index - 1]) violations.push(`Duplicate new migration prefix ${numbers[index]}.`);
  }
  return violations;
}
