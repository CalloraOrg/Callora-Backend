#!/usr/bin/env node

/**
 * Schema Drift Validation Script
 * 
 * This script detects and reports schema drift issues between ORM configurations.
 * It provides recommendations for fixing identified inconsistencies.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

class SchemaDriftValidator {
  constructor() {
    this.issues = [];
    this.validate();
  }

  validate() {
    console.log('🔍 Auditing schema drift...\n');

    this.checkOrmConflicts();
    this.checkEntityConsistency();
    this.checkConnectionPatterns();
    this.checkMigrationConsistency();
    this.checkTypeSafety();

    this.report();
  }

  checkOrmConflicts() {
    const drizzleConfig = path.join(projectRoot, 'drizzle.config.ts');
    const prismaSchema = path.join(projectRoot, 'prisma/schema.prisma');

    if (!fs.existsSync(drizzleConfig) || !fs.existsSync(prismaSchema)) {
      return;
    }

    const drizzleContent = fs.readFileSync(drizzleConfig, 'utf8');
    const prismaContent = fs.readFileSync(prismaSchema, 'utf8');

    const drizzleDriver = drizzleContent.includes('better-sqlite') ? 'sqlite' : 'unknown';
    const prismaProvider = prismaContent.includes('postgresql') ? 'postgresql' : 
                          prismaContent.includes('sqlite') ? 'sqlite' : 'unknown';

    if (drizzleDriver !== prismaProvider && drizzleDriver !== 'unknown' && prismaProvider !== 'unknown') {
      this.issues.push({
        type: 'error',
        category: 'orm-conflict',
        description: `Drizzle configured for ${drizzleDriver} but Prisma configured for ${prismaProvider}`,
        recommendation: 'Consolidate to a single ORM and database provider',
        files: [drizzleConfig, prismaSchema]
      });
    }
  }

  checkEntityConsistency() {
    const drizzleSchema = path.join(projectRoot, 'src/db/schema.ts');
    const prismaSchema = path.join(projectRoot, 'prisma/schema.prisma');

    if (!fs.existsSync(drizzleSchema) || !fs.existsSync(prismaSchema)) {
      return;
    }

    const drizzleEntities = this.extractDrizzleEntities(fs.readFileSync(drizzleSchema, 'utf8'));
    const prismaEntities = this.extractPrismaEntities(fs.readFileSync(prismaSchema, 'utf8'));

    // Check for completely different entity sets
    const commonEntities = drizzleEntities.filter(entity => 
      prismaEntities.some(pEntity => entity.toLowerCase() === pEntity.toLowerCase())
    );

    if (drizzleEntities.length > 0 && prismaEntities.length > 0 && commonEntities.length === 0) {
      this.issues.push({
        type: 'error',
        category: 'entity-mismatch',
        description: `No common entities between Drizzle (${drizzleEntities.join(', ')}) and Prisma (${prismaEntities.join(', ')})`,
        recommendation: 'Align entity definitions or remove unused ORM',
        files: [drizzleSchema, prismaSchema]
      });
    }
  }

  checkConnectionPatterns() {
    const dbIndex = path.join(projectRoot, 'src/db/index.ts');
    const dbTs = path.join(projectRoot, 'src/db.ts');
    const prismaLib = path.join(projectRoot, 'src/lib/prisma.ts');

    const connections = [];
    const connectionFiles = [];

    if (fs.existsSync(dbIndex)) {
      const content = fs.readFileSync(dbIndex, 'utf8');
      if (content.includes('drizzle')) {
        connections.push('drizzle');
        connectionFiles.push(dbIndex);
      }
    }

    if (fs.existsSync(dbTs)) {
      const content = fs.readFileSync(dbTs, 'utf8');
      if (content.includes('pg')) {
        connections.push('postgresql');
        connectionFiles.push(dbTs);
      }
    }

    if (fs.existsSync(prismaLib)) {
      const content = fs.readFileSync(prismaLib, 'utf8');
      if (content.includes('PrismaClient')) {
        connections.push('prisma');
        connectionFiles.push(prismaLib);
      }
    }

    if (connections.length > 1) {
      this.issues.push({
        type: 'warning',
        category: 'connection-drift',
        description: `Multiple database connection patterns detected: ${connections.join(', ')}`,
        recommendation: 'Consolidate to a single database connection pattern',
        files: connectionFiles
      });
    }
  }

  checkMigrationConsistency() {
    const migrationsDir = path.join(projectRoot, 'migrations');
    const drizzleSchema = path.join(projectRoot, 'src/db/schema.ts');

    if (!fs.existsSync(drizzleSchema)) {
      return;
    }

    const drizzleEntities = this.extractDrizzleEntities(fs.readFileSync(drizzleSchema, 'utf8'));

    if (fs.existsSync(migrationsDir)) {
      const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'));

      if (drizzleEntities.length > 0 && migrationFiles.length === 0) {
        this.issues.push({
          type: 'warning',
          category: 'migration-gap',
          description: 'Schema entities exist but no migration files found',
          recommendation: 'Generate migrations for schema entities',
          files: [drizzleSchema, migrationsDir]
        });
      }
    }
  }

  checkTypeSafety() {
    const drizzleSchema = path.join(projectRoot, 'src/db/schema.ts');

    if (!fs.existsSync(drizzleSchema)) {
      return;
    }

    const content = fs.readFileSync(drizzleSchema, 'utf8');
    const entities = this.extractDrizzleEntities(content);
    const typeExports = content.match(/export type \w+/g) || [];

    // Check if all entities have corresponding type exports
    const expectedTypes = entities.map(entity => `${entity.charAt(0).toUpperCase() + entity.slice(1)}`);
    const missingTypes = expectedTypes.filter(expectedType => 
      !typeExports.some(typeExport => typeExport.includes(expectedType))
    );

    if (missingTypes.length > 0) {
      this.issues.push({
        type: 'warning',
        category: 'type-safety',
        description: `Missing type exports for: ${missingTypes.join(', ')}`,
        recommendation: 'Add type exports for all schema entities',
        files: [drizzleSchema]
      });
    }
  }

  extractDrizzleEntities(schema) {
    const entities = [];
    const tableMatches = schema.match(/export const \w+ = sqliteTable/g) || [];

    for (const match of tableMatches) {
      const entityName = match.match(/export const (\w+) = sqliteTable/)?.[1];
      if (entityName) {
        entities.push(entityName);
      }
    }

    return entities;
  }

  extractPrismaEntities(schema) {
    const entities = [];
    const modelMatches = schema.match(/model \w+ \{/g) || [];

    for (const match of modelMatches) {
      const entityName = match.match(/model (\w+) \{/)?.[1];
      if (entityName) {
        entities.push(entityName);
      }
    }

    return entities;
  }

  report() {
    console.log('📊 Schema Drift Audit Results\n');

    if (this.issues.length === 0) {
      console.log('✅ No schema drift issues detected!');
      return;
    }

    const errors = this.issues.filter(issue => issue.type === 'error');
    const warnings = this.issues.filter(issue => issue.type === 'warning');

    if (errors.length > 0) {
      console.log(`🚨 Found ${errors.length} error(s):\n`);
      errors.forEach((issue, index) => {
        console.log(`${index + 1}. [${issue.category.toUpperCase()}] ${issue.description}`);
        console.log(`   💡 Recommendation: ${issue.recommendation}`);
        console.log(`   📁 Files: ${issue.files.map(f => path.relative(projectRoot, f)).join(', ')}\n`);
      });
    }

    if (warnings.length > 0) {
      console.log(`⚠️  Found ${warnings.length} warning(s):\n`);
      warnings.forEach((issue, index) => {
        console.log(`${index + 1}. [${issue.category.toUpperCase()}] ${issue.description}`);
        console.log(`   💡 Recommendation: ${issue.recommendation}`);
        console.log(`   📁 Files: ${issue.files.map(f => path.relative(projectRoot, f)).join(', ')}\n`);
      });
    }

    console.log('🔧 Recommended Fixes:\n');
    console.log('1. Choose one ORM (Drizzle or Prisma) and remove the other');
    console.log('2. Align database providers (SQLite vs PostgreSQL)');
    console.log('3. Ensure entity definitions match across schemas');
    console.log('4. Generate migrations for schema changes');
    console.log('5. Add type exports for all entities');

    // Exit with error code if issues found
    process.exit(errors.length > 0 ? 1 : 0);
  }
}

// Run the validator
new SchemaDriftValidator();
