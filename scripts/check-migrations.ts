#!/usr/bin/env tsx
/**
 * check-migrations.ts  —  Schema Versioning CI Gate
 *
 * Verifies that every migration file on disk matches its recorded checksum in the
 * schema_versions table.  Any mismatch means a migration was modified *after* being
 * applied (schema drift), which causes the script to exit non-zero, failing CI.
 *
 * Also validates:
 *   - No missing schema_versions records (migration applied but not tracked)
 *   - No orphaned records (migration file deleted but still tracked)
 *   - File system and DB are consistent
 *
 * Usage:
 *   npx tsx scripts/check-migrations.ts
 *   CHECKSUM_CI_SKIP_MISSING=1 npx tsx scripts/check-migrations.ts
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

const rootDir = process.cwd();
const dbPath = path.join(rootDir, 'database.db');
const migrationDir = path.join(rootDir, 'migrations');
const SKIP_MISSING = process.env.CHECKSUM_CI_SKIP_MISSING === '1';

function computeChecksum(filePath) {
  return createHash('sha256').update(readFileSync(filePath, 'utf8'), 'utf8').digest('hex');
}

function extractPrefix(filename) {
  var m = filename.match(/^(\d+)_/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function main() {
  console.log('');
  console.log('Schema Versioning Drift Check');
  console.log('================================');
  console.log('');
  if (!existsSync(dbPath)) {
    console.log('No database file found. Skipping checksum verification.');
    console.log('(Expected on fresh checkout before running migrations.)');
    process.exit(0);
  }
  var db = new Database(dbPath);
  try {
    var tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'").get();
    if (!tableExists) {
      console.log('schema_versions table does not exist. Has migration 0013 been applied?');
      if (!SKIP_MISSING) {
        console.log('Run npx tsx src/migrate.ts to apply pending migrations.');
        process.exit(1);
      }
      console.log('CHECKSUM_CI_SKIP_MISSING=1 set -- skipping check.');
      process.exit(0);
    }
    var dbRecords = db.prepare('SELECT version, filename, checksum, applied_at FROM schema_versions ORDER BY version').all();
    console.log('Found ' + dbRecords.length + ' recorded migration(s) in schema_versions.');
    console.log('');
    var diskFiles = readdirSync(migrationDir).filter(function(f) { return (f.endsWith('.sql') || f.endsWith('.up.sql')) && !f.endsWith('.down.sql'); });
    var errors = [];
    var warnings = [];
    var passed = 0;
    for (var i = 0; i < dbRecords.length; i++) {
      var record = dbRecords[i];
      var fp = path.join(migrationDir, record.filename);
      if (!existsSync(fp)) {
        warnings.push('Migration file "' + record.filename + '" is recorded but missing from disk.');
        continue;
      }
      var cc = computeChecksum(fp);
      if (cc !== record.checksum) {
        errors.push('CHECKSUM MISMATCH for "' + record.filename + '" (v' + record.version + '):');
        errors.push('  Recorded: ' + record.checksum);
        errors.push('  Current:  ' + cc);
        errors.push('  The migration file was modified after being applied!');
      } else {
        passed++;
      }
    }
    var recordedFilenames = new Set();
    for (var j = 0; j < dbRecords.length; j++) { recordedFilenames.add(dbRecords[j].filename); }
    var unrecordedFiles = diskFiles.filter(function(f) { return !recordedFilenames.has(f); });
    if (unrecordedFiles.length > 0) {
      var recordedPrefixes = new Set();
      for (var k = 0; k < dbRecords.length; k++) { recordedPrefixes.add(dbRecords[k].version); }
      var unapplied = unrecordedFiles.filter(function(f) { var p = extractPrefix(f); return p !== null && !recordedPrefixes.has(p); });
      var replaced = unrecordedFiles.filter(function(f) { var p = extractPrefix(f); return p !== null && recordedPrefixes.has(p); });
      if (replaced.length > 0) {
        errors.push('Found ' + replaced.length + ' file(s) that conflict with recorded migrations:');
        for (var ri = 0; ri < replaced.length; ri++) { errors.push('  - ' + replaced[ri]); }
      }
      if (unapplied.length > 0) {
        warnings.push('Found ' + unapplied.length + ' new migration file(s) not yet applied:');
        for (var ui = 0; ui < unapplied.length; ui++) { warnings.push('  - ' + unapplied[ui]); }
      }
    }
    console.log('' + passed + ' checksum(s) verified.');
    console.log('');
    if (warnings.length > 0) { console.log(warnings.length + ' warning(s):'); for (var wi = 0; wi < warnings.length; wi++) { console.log('  ' + warnings[wi]); } console.log(''); }
    if (errors.length > 0) {
      console.log(errors.length + ' error(s) -- schema drift detected!');
      for (var ei = 0; ei < errors.length; ei++) { console.log('  ' + errors[ei]); }
      console.log('Fix: Restore the original migration files or create a new migration.');
      process.exit(1);
    }
    console.log('No schema drift detected. All checksums match.');
    process.exit(0);
  } finally { db.close(); }
}
main();