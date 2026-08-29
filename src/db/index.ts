import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { applyMigrations, validateSchemaState } from '../migrate.js';

const logger = console;
let sqliteClosed = false;

// Create SQLite database instance
/**
 * The underlying connection is exported for the small number of repository
 * operations that must run synchronously in a SQLite transaction.
 */
export const sqlite = new Database('./database.db');

// Create Drizzle instance with schema
export const db = drizzle(sqlite, { schema });

// Simple migration runner
export async function initializeDb() {
  try {
    const migrationDir = join(process.cwd(), 'migrations');
    
    // In production, we just want to validate the schema is up-to-date.
    // In dev/test environments, we automatically apply pending migrations.
    const isProd = process.env.NODE_ENV === 'production';
    
    if (isProd) {
      logger.info('Validating schema state...');
      validateSchemaState(sqlite, migrationDir);
      logger.info('✅ Schema validation successful');
    } else {
      logger.info('Applying database migrations...');
      applyMigrations(sqlite, migrationDir);
      logger.info('✅ Migrations completed');
    }
  } catch (error) {
    logger.error('Failed to initialize database schema:', error);
    throw error;
  }
}

// Graceful shutdown
// Export close function for graceful shutdown
export async function closeDb(): Promise<void> {
  if (sqliteClosed) {
    return;
  }
  sqlite.close();
  sqliteClosed = true;
}
export { schema };
