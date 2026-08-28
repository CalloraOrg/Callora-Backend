import assert from 'assert';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { discoverMigrations } from './migrate.js';

describe('Migration Rollback Contracts', () => {
  const migrationDir = path.join(process.cwd(), 'migrations');

  function getSchemaSnapshot(db: Database.Database): any[] {
    return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migrations' AND name NOT LIKE 'schema_versions' ORDER BY name").all();
  }

  it('verifies all migration rollback contracts against the current schema', () => {
    // 1. Discover all up migrations
    const available = discoverMigrations(migrationDir);
    
    // We will test sequentially: apply up, apply down, check if matches, then apply up again to continue.
    const db = new Database(':memory:');
    
    // We only test migrations that actually have a .down.sql file
    const allFiles = readdirSync(migrationDir);
    
    for (const filename of available) {
      const upSql = readFileSync(path.join(migrationDir, filename), 'utf8');
      
      const base = filename.replace(/\.up\.sql$/, '').replace(/\.sql$/, '');
      const downFilename = `${base}.down.sql`;
      
      const hasDown = allFiles.includes(downFilename);
      
      if (!hasDown) {
        // If no down file exists, we just apply the up migration and move on.
        // Legacy migrations might not have them.
        db.exec(upSql);
        continue;
      }
      
      const downSql = readFileSync(path.join(migrationDir, downFilename), 'utf8');
      
      // Step 1: Capture schema before the migration
      const schemaBefore = getSchemaSnapshot(db);
      
      // Step 2: Apply UP
      db.exec(upSql);
      
      // Step 3: Apply DOWN
      db.exec(downSql);
      
      // Step 4: Capture schema after rollback
      const schemaAfterRollback = getSchemaSnapshot(db);
      
      // Verify rollback boundary
      assert.deepStrictEqual(
        schemaAfterRollback, 
        schemaBefore, 
        `Rollback contract failed for ${filename}. The schema did not return to its previous state after applying ${downFilename}.`
      );
      
      // Step 5: Apply UP again so the next migration can build upon it
      db.exec(upSql);
    }
    
    db.close();
  });
});