import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create database instance
const db = new Database('./database.db');

try {
  // Read and execute the migration SQL
  const migrationSQL = readFileSync(join(__dirname, '..', 'migrations', '0000_initial_apis_tables.sql'), 'utf8');
  
  // Split by semicolon and execute each statement
  const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
  
  db.exec('BEGIN TRANSACTION');
  
  for (const statement of statements) {
    if (statement.trim()) {
      db.exec(statement);
    }
  }
  
  db.exec('COMMIT');
  
  logger.info('✅ Database migration completed successfully');
  logger.info('Tables created: apis, api_endpoints');
  logger.info('Indexes created: idx_api_endpoints_api_id, idx_apis_developer_id, idx_apis_status');
  
} catch (error) {
  db.exec('ROLLBACK');
  logger.error('❌ Migration failed:', error);
  throw error;
} finally {
  db.close();
}
