import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const logger = console;

// Create SQLite database instance
const sqlite = new Database('./database.db');

// Create Drizzle instance with schema
export const db = drizzle(sqlite, { schema });

// Simple migration runner
export async function initializeDb() {
  try {
    // Check if migration has already been run
    const tableExists = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='apis'
    `).get();

    if (!tableExists) {
      logger.info('Running initial migration...');
      const migrationSQL = readFileSync(
        join(process.cwd(), 'migrations', '0000_initial_apis_tables.sql'),
        'utf8'
      );
      const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
      sqlite.exec('BEGIN TRANSACTION');
      for (const statement of statements) {
        if (statement.trim()) sqlite.exec(statement);
      }
      sqlite.exec('COMMIT');
      logger.info('✅ Initial migration completed');
    }

    const developersExists = sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='developers'
    `).get();
    if (!developersExists) {
      logger.info('Running developers migration...');
      const devSQL = readFileSync(
        join(process.cwd(), 'migrations', '0004_create_developers.sql'),
        'utf8'
      );
      const statements = devSQL.split(';').filter(stmt => stmt.trim());
      sqlite.exec('BEGIN TRANSACTION');
      for (const statement of statements) {
        if (statement.trim()) sqlite.exec(statement);
      }
      sqlite.exec('COMMIT');
      logger.info('✅ Developers migration completed');
    }
  } catch (error) {
    logger.error('Failed to run database migrations:', error);
    throw error;
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  sqlite.close();
  process.exit(0);
});

export { schema };
