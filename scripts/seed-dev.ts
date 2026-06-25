#!/usr/bin/env tsx

/**
 * Seed script for local development.
 *
 * Populates the database with sample data so developers can work locally
 * without needing a full production dataset.
 *
 * Usage:
 *   npm run seed:dev
 *
 * The script is idempotent — running it multiple times will upsert rather than
 * duplicate rows.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Logging ─────────────────────────────────────────────────────────────────

const logger = console;

// ── Migration helpers ───────────────────────────────────────────────────────

function ensureMigrations(sqlite: Database.Database) {
  const tables = [
    { name: 'apis', file: '0000_initial_apis_tables.sql' },
    { name: 'developers', file: '0004_create_developers.sql' },
  ];

  for (const { name, file } of tables) {
    const exists = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    if (!exists) {
      logger.info(`Running migration: ${file}`);
      const sql = readFileSync(join(process.cwd(), 'migrations', file), 'utf8');
      const statements = sql.split(';').filter((s) => s.trim());
      sqlite.exec('BEGIN TRANSACTION');
      for (const stmt of statements) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
      sqlite.exec('COMMIT');
      logger.info(`  ✅ Migration ${file} applied`);
    }
  }
}

// ── Seed data ───────────────────────────────────────────────────────────────

interface DeveloperSeed {
  user_id: string;
  name: string | null;
  website: string | null;
  description: string | null;
  category: string | null;
}

interface EndpointSeed {
  path: string;
  method: string;
  price_per_call_usdc: string;
  description: string | null;
}

interface ApiSeed {
  developer_user_id: string;
  name: string;
  description: string | null;
  base_url: string;
  category: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  endpoints: EndpointSeed[];
}

const DEVELOPERS: DeveloperSeed[] = [
  {
    user_id: 'dev_001',
    name: 'Alice Developer',
    website: 'https://alice-dev.example.com',
    description: 'Weather API provider and data analytics specialist',
    category: 'analytics',
  },
  {
    user_id: 'dev_002',
    name: 'Bob Builder',
    website: 'https://bob-builder.example.com',
    description: 'Translation and NLP API provider',
    category: 'ai',
  },
  {
    user_id: 'dev_003',
    name: 'Carol Coder',
    website: null,
    description: 'Payment processing API developer',
    category: 'payments',
  },
];

const APIS: ApiSeed[] = [
  {
    developer_user_id: 'dev_001',
    name: 'Weather API',
    description: 'Real-time weather data and forecasts for any location worldwide',
    base_url: 'http://localhost:4000',
    category: 'analytics',
    status: 'active',
    endpoints: [
      { path: '/current', method: 'GET', price_per_call_usdc: '0.01', description: 'Get current weather for a location' },
      { path: '/forecast', method: 'GET', price_per_call_usdc: '0.05', description: 'Get 7-day weather forecast' },
      { path: '/historical', method: 'GET', price_per_call_usdc: '0.02', description: 'Get historical weather data' },
      { path: '/alerts', method: 'GET', price_per_call_usdc: '0.005', description: 'Get weather alerts for a region' },
    ],
  },
  {
    developer_user_id: 'dev_002',
    name: 'Translation API',
    description: 'Fast and accurate text translation across 50+ languages',
    base_url: 'http://localhost:4001',
    category: 'ai',
    status: 'active',
    endpoints: [
      { path: '/translate', method: 'POST', price_per_call_usdc: '0.02', description: 'Translate text from one language to another' },
      { path: '/detect', method: 'GET', price_per_call_usdc: '0.005', description: 'Detect the language of provided text' },
      { path: '/languages', method: 'GET', price_per_call_usdc: '0.001', description: 'List all supported languages' },
    ],
  },
  {
    developer_user_id: 'dev_003',
    name: 'Payment Gateway API',
    description: 'Simple payment processing and invoice management API',
    base_url: 'http://localhost:4002',
    category: 'payments',
    status: 'draft',
    endpoints: [
      { path: '/charges', method: 'POST', price_per_call_usdc: '0.10', description: 'Create a new charge' },
      { path: '/charges/:id', method: 'GET', price_per_call_usdc: '0.01', description: 'Retrieve charge details' },
      { path: '/invoices', method: 'POST', price_per_call_usdc: '0.05', description: 'Create a new invoice' },
      { path: '/invoices/:id', method: 'GET', price_per_call_usdc: '0.01', description: 'Retrieve invoice details' },
    ],
  },
];

// ── Seeder ──────────────────────────────────────────────────────────────────

function seed() {
  logger.info('🌱 Seeding development database...\n');

  const sqlite = new Database('./database.db');
  ensureMigrations(sqlite);

  // ── Seed developers ─────────────────────────────────────────────────
  logger.info('Seeding developers...');

  let devCount = 0;
  for (const dev of DEVELOPERS) {
    const existing = sqlite
      .prepare('SELECT id FROM developers WHERE user_id = ?')
      .get(dev.user_id) as { id: number } | undefined;

    if (existing) {
      sqlite
        .prepare(
          `UPDATE developers SET name = ?, website = ?, description = ?, category = ?, updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(dev.name, dev.website, dev.description, dev.category, existing.id);
      logger.info(`  ⏭️  Developer already exists, updated: ${dev.user_id}`);
    } else {
      sqlite
        .prepare(
          `INSERT INTO developers (user_id, name, website, description, category, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
        )
        .run(dev.user_id, dev.name, dev.website, dev.description, dev.category);
      devCount++;
      logger.info(`  ✅ Created developer: ${dev.name} (${dev.user_id})`);
    }
  }
  logger.info(`  → ${devCount} developers created\n`);

  // ── Seed APIs and endpoints ─────────────────────────────────────────
  logger.info('Seeding APIs and endpoints...');

  let apiCount = 0;
  let endpointCount = 0;

  for (const api of APIS) {
    const devResult = sqlite
      .prepare('SELECT id FROM developers WHERE user_id = ?')
      .get(api.developer_user_id) as { id: number } | undefined;

    if (!devResult) {
      logger.warn(`  ⚠️  Developer ${api.developer_user_id} not found, skipping API: ${api.name}`);
      continue;
    }

    const developerId = devResult.id;

    // Upsert API (by name + developer_id)
    const existingApi = sqlite
      .prepare('SELECT id FROM apis WHERE developer_id = ? AND name = ?')
      .get(developerId, api.name) as { id: number } | undefined;

    let apiId: number;
    if (existingApi) {
      apiId = existingApi.id;
      sqlite
        .prepare(
          `UPDATE apis SET description = ?, base_url = ?, category = ?, status = ?, updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(api.description, api.base_url, api.category, api.status, apiId);
      logger.info(`  ⏭️  API already exists, updated: ${api.name}`);
    } else {
      const result = sqlite
        .prepare(
          `INSERT INTO apis (developer_id, name, description, base_url, category, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
        )
        .run(developerId, api.name, api.description, api.base_url, api.category, api.status);
      apiId = result.lastInsertRowid as number;
      apiCount++;
      logger.info(`  ✅ Created API: ${api.name}`);
    }

    // Upsert endpoints for this API
    for (const ep of api.endpoints) {
      const existingEp = sqlite
        .prepare('SELECT id FROM api_endpoints WHERE api_id = ? AND path = ? AND method = ?')
        .get(apiId, ep.path, ep.method) as { id: number } | undefined;

      if (existingEp) {
        sqlite
          .prepare(
            `UPDATE api_endpoints SET price_per_call_usdc = ?, description = ?, updated_at = unixepoch()
             WHERE id = ?`,
          )
          .run(ep.price_per_call_usdc, ep.description, existingEp.id);
      } else {
        sqlite
          .prepare(
            `INSERT INTO api_endpoints (api_id, path, method, price_per_call_usdc, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
          )
          .run(apiId, ep.path, ep.method, ep.price_per_call_usdc, ep.description);
        endpointCount++;
      }
    }
  }

  logger.info(`  → ${apiCount} APIs created`);
  logger.info(`  → ${endpointCount} endpoints created\n`);

  // ── Summary ─────────────────────────────────────────────────────────
  const totalDevs = (
    sqlite.prepare('SELECT COUNT(*) as count FROM developers').get() as { count: number }
  ).count;
  const totalApis = (
    sqlite.prepare('SELECT COUNT(*) as count FROM apis').get() as { count: number }
  ).count;
  const totalEndpoints = (
    sqlite.prepare('SELECT COUNT(*) as count FROM api_endpoints').get() as { count: number }
  ).count;

  logger.info('📊 Database summary:');
  logger.info(`  Developers:  ${totalDevs}`);
  logger.info(`  APIs:        ${totalApis}`);
  logger.info(`  Endpoints:   ${totalEndpoints}`);
  logger.info('\n✅ Seed complete!');

  sqlite.close();
}

try {
  seed();
} catch (err) {
  logger.error('❌ Seed failed:', err);
  process.exit(1);
}
