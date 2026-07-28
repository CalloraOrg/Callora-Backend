/**
 * Tests for refunds counts endpoint (#678).
 *
 * Covers:
 *   - Developer-scoped counts (own disputes only)
 *   - Admin counts (all disputes, byDeveloper breakdown)
 *   - Auth enforcement on both routes
 *   - Edge cases: empty state, mixed statuses
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createRefundsCountsRouter } from './counts.js';
import {
  InMemoryDisputeRepository,
  DisputeService,
} from '../../services/disputeService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-admin-key';

function buildApp(svc?: DisputeService) {
  const app = express();
  app.use(express.json());
  app.use('/api/refunds', createRefundsCountsRouter({ disputeService: svc }));
  app.use(errorHandler);
  return app;
}

function makeSvc() {
  const repo = new InMemoryDisputeRepository();
  return { svc: new DisputeService(repo), repo };
}

// ---------------------------------------------------------------------------
// Schema / helper
// ---------------------------------------------------------------------------

describe('computeCounts', () => {
  it('counts mixed statuses correctly', async () => {
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u1');
    const d3 = svc.openDispute({ usage_event_id: 'e3', reason: 'z' }, 'u2');
    svc.resolveDispute(d3.id, { resolution: 'REFUNDED' }, 'admin');

    const res = await request(buildApp(svc))
      .get('/api/refunds')
      .set('x-user-id', 'u1');

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.OPEN).toBe(2);
    expect(res.body.counts.REFUNDED).toBe(0);
    expect(res.body.counts.UPHELD).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/refunds — developer counts
// ---------------------------------------------------------------------------

describe('GET /api/refunds', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/refunds');
    expect(res.status).toBe(401);
  });

  it('returns zero counts for developer with no disputes', async () => {
    const { svc } = makeSvc();
    const res = await request(buildApp(svc))
      .get('/api/refunds')
      .set('x-user-id', 'u1');

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(0);
    expect(res.body.counts.OPEN).toBe(0);
    expect(res.body.counts.REFUNDED).toBe(0);
    expect(res.body.counts.UPHELD).toBe(0);
    expect(res.body.scope).toBe('developer');
  });

  it('counts only the authenticated user disputes', async () => {
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u1');
    svc.openDispute({ usage_event_id: 'e3', reason: 'z' }, 'u2');

    const res = await request(buildApp(svc))
      .get('/api/refunds')
      .set('x-user-id', 'u1');

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(2);
  });

  it('counts statuses across different resolutions', async () => {
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    const d2 = svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u1');
    const d3 = svc.openDispute({ usage_event_id: 'e3', reason: 'z' }, 'u1');
    svc.resolveDispute(d2.id, { resolution: 'REFUNDED' }, 'admin');
    svc.resolveDispute(d3.id, { resolution: 'UPHELD' }, 'admin');

    const res = await request(buildApp(svc))
      .get('/api/refunds')
      .set('x-user-id', 'u1');

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(3);
    expect(res.body.counts.OPEN).toBe(1);
    expect(res.body.counts.REFUNDED).toBe(1);
    expect(res.body.counts.UPHELD).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/refunds/admin — admin counts
// ---------------------------------------------------------------------------

describe('GET /api/refunds/admin', () => {
  it('returns 401 without admin auth', async () => {
    const res = await request(buildApp()).get('/api/refunds/admin');
    expect(res.status).toBe(401);
  });

  it('returns zero counts when no disputes exist', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();

    const res = await request(buildApp(svc))
      .get('/api/refunds/admin')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(0);
    expect(res.body.scope).toBe('admin');
    expect(res.body.byDeveloper).toEqual({});
  });

  it('returns total counts and byDeveloper breakdown', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u1');
    svc.openDispute({ usage_event_id: 'e3', reason: 'z' }, 'u2');
    const d4 = svc.openDispute({ usage_event_id: 'e4', reason: 'w' }, 'u2');
    svc.resolveDispute(d4.id, { resolution: 'REFUNDED' }, 'admin');

    const res = await request(buildApp(svc))
      .get('/api/refunds/admin')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(4);
    expect(res.body.counts.OPEN).toBe(3);
    expect(res.body.counts.REFUNDED).toBe(1);
    expect(res.body.counts.UPHELD).toBe(0);
    expect(res.body.byDeveloper).toEqual({ u1: 2, u2: 2 });
  });

  it('counts across all developers', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    const d1 = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    const d2 = svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u2');
    svc.resolveDispute(d1.id, { resolution: 'REFUNDED' }, 'admin');
    svc.resolveDispute(d2.id, { resolution: 'UPHELD' }, 'admin');

    const res = await request(buildApp(svc))
      .get('/api/refunds/admin')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.REFUNDED).toBe(1);
    expect(res.body.counts.UPHELD).toBe(1);
    expect(res.body.byDeveloper).toEqual({ u1: 1, u2: 1 });
  });
});
