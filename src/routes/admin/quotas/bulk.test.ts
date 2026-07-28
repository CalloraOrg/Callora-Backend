import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../../middleware/errorHandler.js';
import { createAdminQuotaBulkRouter } from './bulk.js';

const ADMIN_KEY = 'test-admin-key';

function createMockDb(rows: Array<{ plan_overrides: string | null }>) {
  const queuedRows = [...rows];

  const tx = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => {
            const row = queuedRows.shift();
            return row ? [{ plan_overrides: row.plan_overrides }] : [];
          }),
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve()),
      })),
    })),
  };

  return {
    transaction: async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx),
  };
}

type MockTx = typeof createMockDb extends (rows: Array<{ plan_overrides: string | null }>) => infer R
  ? R extends { transaction: (cb: (tx: infer T) => Promise<unknown>) => Promise<unknown> }
    ? T
    : never
  : never;

type MockDb = {
  transaction: (cb: (tx: MockTx) => Promise<unknown>) => Promise<unknown>;
};

function buildApp(db: MockDb) {
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
    const db = createMockDb([
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
    const db = createMockDb([]);
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
    const db = createMockDb([]);
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

  it('requires admin authentication', async () => {
    const db = createMockDb([]);
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
