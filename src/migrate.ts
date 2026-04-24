import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Use process.cwd() to avoid the __filename SyntaxError in Jest
const rootDir = process.cwd();
const migrationDir = path.join(rootDir, 'migrations');
const dbPath = path.join(rootDir, 'database.db');
const db = new Database(dbPath);

function ensureMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function discoverMigrations() {
  return readdirSync(migrationDir)
    .filter(file => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
}

try {
  ensureMigrationsTable();
  const available = discoverMigrations();

  for (const filename of available) {
    const isExecuted = db.prepare('SELECT id FROM _migrations WHERE name = ?').get(filename);
    if (isExecuted) continue;

    logger.info(`🚀 Running migration: ${filename}`);
    const sql = readFileSync(path.join(migrationDir, filename), 'utf8');

    // Safer, automatic transaction
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
    });

    run();
    logger.info(`✅ Finished ${filename}`);
  }
} catch (error) {
  logger.error('❌ Migration runner failed:', error);
  process.exit(1);
} finally {
  db.close();
}