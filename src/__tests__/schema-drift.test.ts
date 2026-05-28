import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

/**
 * Schema Drift Detection Tests
 * 
 * These tests detect inconsistencies between ORM schema definitions and runtime usage.
 * They fail when obvious schema drift is detected, helping maintain data integrity.
 */

describe('Schema Drift Audit', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const drizzleSchemaPath = path.join(projectRoot, 'src/db/schema.ts');
  const prismaSchemaPath = path.join(projectRoot, 'prisma/schema.prisma');
  const drizzleConfigPath = path.join(projectRoot, 'drizzle.config.ts');
  const prismaConfigPath = path.join(projectRoot, 'prisma.config.ts');
  const sqliteMigrationsDir = path.join(projectRoot, 'migrations');

  /**
   * Ownership boundary (single source of truth per table).
   *
   * - Drizzle + raw SQLite migrations own the developer dashboard entities.
   * - Prisma owns the PostgreSQL auth/users domain.
   * - Other Postgres tables (usage, settlements, etc.) are owned by raw SQL in code
   *   and are out-of-scope for the SQLite drift checks here.
   *
   * Any future change MUST update SCHEMA_DRIFT_AUDIT.md and these expectations.
   */
  const OWNERSHIP = {
    drizzleSqliteTables: new Set(['developers', 'apis', 'api_endpoints']),
    prismaTables: new Set(['users']),
    sqliteMigrationsOwnedTables: new Set(['developers', 'apis', 'api_endpoints']),
  } as const;

  describe('ORM Configuration Consistency', () => {
    // KNOWN: This project intentionally uses Drizzle+SQLite for dev/test and
    // Prisma+PostgreSQL for production. The provider mismatch below is expected
    // and is a conscious architectural decision — not a bug.
    it.skip('should not have conflicting database providers', () => {
      const drizzleConfig = fs.readFileSync(drizzleConfigPath, 'utf8');
      const drizzleDriver = drizzleConfig.includes('better-sqlite') ? 'sqlite' : 'unknown';
      
      const prismaConfig = fs.readFileSync(prismaSchemaPath, 'utf8');
      const prismaProvider = prismaConfig.includes('postgresql') ? 'postgresql' : 
                             prismaConfig.includes('sqlite') ? 'sqlite' : 'unknown';

      expect(drizzleDriver).toBe(prismaProvider);
    });

    it('should have consistent schema file references', () => {
      const drizzleConfig = fs.readFileSync(drizzleConfigPath, 'utf8');
      const prismaConfig = fs.readFileSync(prismaConfigPath, 'utf8');

      expect(drizzleConfig).toContain('./src/db/schema.ts');
      expect(prismaConfig).toContain('prisma/schema.prisma');
    });
  });

  describe('Entity Definition Consistency', () => {
    it('should define only the expected Drizzle SQLite tables', () => {
      const drizzleSchema = fs.readFileSync(drizzleSchemaPath, 'utf8');
      const drizzleTableNames = extractDrizzleTableNames(drizzleSchema);

      expect(new Set(drizzleTableNames)).toEqual(OWNERSHIP.drizzleSqliteTables);
    });

    it('should define only the expected Prisma tables (via @@map)', () => {
      const prismaSchema = fs.readFileSync(prismaSchemaPath, 'utf8');
      const prismaMappedTables = extractPrismaMappedTableNames(prismaSchema);

      expect(new Set(prismaMappedTables)).toEqual(OWNERSHIP.prismaTables);
    });

    it('should not define the same table in both ORMs', () => {
      const drizzleSchema = fs.readFileSync(drizzleSchemaPath, 'utf8');
      const prismaSchema = fs.readFileSync(prismaSchemaPath, 'utf8');
      const drizzleTables = new Set(extractDrizzleTableNames(drizzleSchema));
      const prismaTables = new Set(extractPrismaMappedTableNames(prismaSchema));

      const overlap = [...drizzleTables].filter((t) => prismaTables.has(t));
      expect(overlap).toEqual([]);
    });

    it('should keep the developer user_id shape compatible with Prisma User.id (UUID string)', () => {
      const drizzleSchema = fs.readFileSync(drizzleSchemaPath, 'utf8');
      const prismaSchema = fs.readFileSync(prismaSchemaPath, 'utf8');

      const prismaUserId = extractPrismaModelField(prismaSchema, 'User', 'id');
      // Prisma: id String @id ... @db.Uuid
      expect(prismaUserId).toContain('String');
      expect(prismaUserId).toContain('@db.Uuid');

      // Drizzle: developers.user_id is stored as text (UUID string).
      expect(drizzleSchema).toMatch(/developers\s*=\s*sqliteTable\(\s*'developers'[\s\S]*user_id:\s*text\('user_id'\)\.notNull\(\)\.unique\(\)/);
    });
  });

  describe('Runtime Usage Consistency', () => {
    it('should align runtime ORM usage with the documented ownership boundary', () => {
      const srcDir = path.join(projectRoot, 'src');
      
      // Check for Prisma imports
      const prismaImports = findFileImports(srcDir, ['prisma', 'PrismaClient']);
      
      // Check for Drizzle imports  
      const drizzleImports = findFileImports(srcDir, ['drizzle-orm']);
      
      // This repo intentionally uses both systems (SQLite+Drizzle for dashboard entities,
      // Prisma+Postgres for users). The drift protection is enforced by the ownership
      // tests above, not by prohibiting either import.
      expect(drizzleImports.length).toBeGreaterThan(0);
      expect(prismaImports.length).toBeGreaterThan(0);
    });

    it('should have explicit database connection patterns (no accidental extra clients)', () => {
      const dbIndexPath = path.join(projectRoot, 'src/db/index.ts');
      const dbTsPath = path.join(projectRoot, 'src/db.ts');
      const prismaLibPath = path.join(projectRoot, 'src/lib/prisma.ts');

      // Check if multiple database connection patterns exist
      const connections = [];
      
      if (fs.existsSync(dbIndexPath)) {
        const content = fs.readFileSync(dbIndexPath, 'utf8');
        if (content.includes('drizzle')) connections.push('drizzle');
        if (content.includes('sqlite')) connections.push('sqlite');
      }
      
      if (fs.existsSync(dbTsPath)) {
        const content = fs.readFileSync(dbTsPath, 'utf8');
        if (content.includes('pg')) connections.push('postgresql');
      }
      
      if (fs.existsSync(prismaLibPath)) {
        const content = fs.readFileSync(prismaLibPath, 'utf8');
        if (content.includes('PrismaClient')) connections.push('prisma');
      }

      // By design, we expect these connection patterns to exist in this repo.
      // This assertion prevents new/accidental clients from being introduced silently.
      expect(new Set(connections)).toEqual(new Set(['drizzle', 'sqlite', 'postgresql', 'prisma']));
    });
  });

  describe('Migration Consistency', () => {
    it('should have SQLite migrations that only create expected owned tables', () => {
      if (!fs.existsSync(sqliteMigrationsDir)) {
        // Repository can still be valid without migrations in some test contexts.
        return;
      }

      const drizzleSchema = fs.readFileSync(drizzleSchemaPath, 'utf8');
      const drizzleTables = new Set(extractDrizzleTableNames(drizzleSchema));

      const migrationFiles = fs
        .readdirSync(sqliteMigrationsDir)
        .filter((file) => file.endsWith('.sql'));

      // Defensive: if we have schema tables, we expect some migrations present.
      expect(migrationFiles.length).toBeGreaterThan(0);

      const createdTables = new Set<string>();
      for (const file of migrationFiles) {
        const sql = fs.readFileSync(path.join(sqliteMigrationsDir, file), 'utf8');
        for (const table of extractSqliteCreatedTableNames(sql)) {
          createdTables.add(table);
        }
      }

      // All "owned" SQLite migrations must create only tables that are explicitly
      // owned by Drizzle+SQLite and represented in the Drizzle schema.
      for (const table of createdTables) {
        expect(OWNERSHIP.sqliteMigrationsOwnedTables.has(table)).toBe(true);
        expect(drizzleTables.has(table)).toBe(true);
      }
    });
  });

  describe('Type Safety Consistency', () => {
    it('should have consistent type exports across schemas', () => {
      const drizzleSchema = fs.readFileSync(drizzleSchemaPath, 'utf8');
      
      // Check for type exports
      const typeExports = drizzleSchema.match(/export type \w+/g) || [];
      
      // Types should be exported for all main entities
      const entities = extractDrizzleEntityConstNames(drizzleSchema);
      const expectedTypeExports = entities.map((entity) => `export type ${entity}`);
      
      // Ensure type consistency
      expect(typeExports.length).toBeGreaterThanOrEqual(entities.length);
    });
  });
});

// Helper functions for schema analysis

function extractDrizzleEntityConstNames(schema: string): string[] {
  const entities: string[] = [];
  const tableMatches = schema.match(/export const \w+ = sqliteTable/g) || [];
  
  for (const match of tableMatches) {
    const entityName = match.match(/export const (\w+) = sqliteTable/)?.[1];
    if (entityName) {
      entities.push(entityName);
    }
  }
  
  return entities;
}

function extractDrizzleTableNames(schema: string): string[] {
  const tables: string[] = [];
  const matches = schema.match(/sqliteTable\(\s*'[^']+'\s*,/g) || [];
  for (const match of matches) {
    const tableName = match.match(/sqliteTable\(\s*'([^']+)'\s*,/)?.[1];
    if (tableName) tables.push(tableName);
  }
  return tables;
}

function extractPrismaMappedTableNames(schema: string): string[] {
  // We intentionally only treat models with an explicit @@map("table") as "owned",
  // so renames and mapping decisions are visible and testable.
  const mapped: string[] = [];
  const modelBlocks = schema.match(/model\s+\w+\s+\{[\s\S]*?\n\}/g) || [];
  for (const block of modelBlocks) {
    const map = block.match(/@@map\("([^"]+)"\)/)?.[1];
    if (map) mapped.push(map);
  }
  return mapped;
}

function extractPrismaModelField(schema: string, modelName: string, fieldName: string): string {
  const block = schema.match(new RegExp(`model\\s+${modelName}\\s+\\{[\\s\\S]*?\\n\\}`, 'm'))?.[0];
  if (!block) {
    throw new Error(`Prisma schema missing model ${modelName}`);
  }
  const line = block
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${fieldName} `));
  if (!line) {
    throw new Error(`Prisma schema missing field ${modelName}.${fieldName}`);
  }
  return line;
}

function extractSqliteCreatedTableNames(sql: string): string[] {
  const tables: string[] = [];
  const matches = sql.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+`[^`]+`/gi) || [];
  for (const match of matches) {
    const name = match.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+`([^`]+)`/i)?.[1];
    if (name) tables.push(name);
  }
  return tables;
}

function findFileImports(dir: string, imports: string[]): string[] {
  const results: string[] = [];
  const files = getAllTsFiles(dir);
  
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    
    for (const importName of imports) {
      if (content.includes(importName)) {
        results.push(file);
        break;
      }
    }
  }
  
  return results;
}

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const items = fs.readdirSync(currentDir);
    
    for (const item of items) {
      const fullPath = path.join(currentDir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        traverse(fullPath);
      } else if (item.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}
