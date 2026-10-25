import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../db/schema.js';

import { errorHandler } from '../../../middleware/errorHandler.js';
import { createAdminQuotaBulkRouter, type AdminQuotaBulkRouterDeps } from './bulk.js';

const ADMIN_KEY = 'test-admin-key';

const connections: Database.Database[] = [];

afterEach(() => {
  for (const connection of connections) connection.close();
  connections.length = 0;
});

function createTestDb(rows: Array<{ plan_overrides: string | null }>) {
  const sqlite = new Database(':memory:');
  connections.push(sqlite);
  sqlite.exec(`
    CREATE TABLE developers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      name TEXT,
      website TEXT,
      description TEXT,
      category TEXT,
      plan_overrides TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  const insert = sqlite.prepare('INSERT INTO developers (user_id, plan_overrides) VALUES (?, ?)');
  rows.forEach((row, index) => insert.run(`dev-${index + 1}`, row.plan_overrides));
  return drizzle(sqlite, { schema });
}

function buildApp(db: NonNullable<AdminQuotaBulkRouterDeps['db']>) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });
  app.use('/api/admin/quotas', createAdminQuotaBulkRouter({ db }));
  app.use(errorHandler);
  return app;
}

describe('POST /api/admin/quotas/bulk-update', () => {
  it('updates plan overrides for multiple developers atomically', async () => {
    const db = createTestDb([
      { plan_overrides: JSON.stringify({ plan_tier: 'free', monthly_call_limit: 50000 }) },
      { plan_overrides: JSON.stringify({ plan_tier: 'free', rate_limit_max_requests: 1000 }) },
    ]);
    const app = buildApp(db);

    const response = await request(app)
      .post('/api/admin/quotas/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        items: [
          { developer_id: 'dev-1', plan_tier: 'pro', monthly_call_limit: 100000 },
          { developer_id: 'dev-2', plan_tier: 'enterprise', rate_limit_max_requests: 5000 },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ updated: 2 });
  });

  it('rejects requests with invalid items', async () => {
    const db = createTestDb([]);
    const app = buildApp(db);

    const response = await request(app)
      .post('/api/admin/quotas/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ items: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].field).toBe('body.items');
  });

  it('returns 404 when a developer does not exist', async () => {
    const db = createTestDb([]);
    const app = buildApp(db);

    const response = await request(app)
      .post('/api/admin/quotas/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        items: [
          { developer_id: 'missing-dev', plan_tier: 'pro' },
        ],
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('rolls back earlier quota changes when a later developer is missing', async () => {
    const original = JSON.stringify({ plan_tier: 'free', monthly_call_limit: 50000 });
    const db = createTestDb([{ plan_overrides: original }]);
    const response = await request(buildApp(db))
      .post('/api/admin/quotas/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        items: [
          { developer_id: 'dev-1', plan_tier: 'pro', monthly_call_limit: 100000 },
          { developer_id: 'missing-dev', plan_tier: 'enterprise' },
        ],
      });

    expect(response.status).toBe(404);
    expect(db.select({ planOverrides: schema.developers.plan_overrides }).from(schema.developers).all())
      .toEqual([{ planOverrides: original }]);
  });

  it('requires admin authentication', async () => {
    const db = createTestDb([]);
    const app = buildApp(db);

    const response = await request(app)
      .post('/api/admin/quotas/bulk-update')
      .send({
        items: [
          { developer_id: 'dev-1', plan_tier: 'pro' },
        ],
      });

    expect(response.status).toBe(401);
  });
});
