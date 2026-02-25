import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import developerRoutes from '../routes/developerRoutes.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/developers', developerRoutes);
  return app;
}

let server: Server;
let baseUrl: string;

before(() => {
  return new Promise<void>((resolve) => {
    const app = buildApp();
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

after(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/developers/revenue', () => {
  it('returns 401 when no auth token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });

  it('returns 401 for an invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer bad-token' },
    });
    assert.equal(res.status, 401);
  });

  it('returns 200 with correct shape for a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer dev-token-1' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    // summary
    assert.ok('summary' in body);
    assert.ok(typeof body.summary.total_earned === 'number');
    assert.ok(typeof body.summary.pending === 'number');
    assert.ok(typeof body.summary.available_to_withdraw === 'number');

    // settlements array
    assert.ok(Array.isArray(body.settlements));
    assert.ok(body.settlements.length > 0);

    // pagination
    assert.ok('pagination' in body);
    assert.ok(typeof body.pagination.limit === 'number');
    assert.ok(typeof body.pagination.offset === 'number');
    assert.ok(typeof body.pagination.total === 'number');
  });

  it('returns correct summary values for dev_001', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer dev-token-1' },
    });
    const body = await res.json();

    // dev_001: completed = 250 + 175.5 = 425.5, usage = 120 → total_earned = 545.5
    // pending = 320 + 410.25 = 730.25
    // available_to_withdraw = 545.5 - 730.25 = -184.75
    assert.equal(body.summary.total_earned, 545.5);
    assert.equal(body.summary.pending, 730.25);
    assert.equal(body.summary.available_to_withdraw, 545.5 - 730.25);
  });

  it('respects limit and offset query params', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=2&offset=0`,
      { headers: { Authorization: 'Bearer dev-token-1' } },
    );
    const body = await res.json();

    assert.equal(body.settlements.length, 2);
    assert.equal(body.pagination.limit, 2);
    assert.equal(body.pagination.offset, 0);
    assert.equal(body.pagination.total, 5); // dev_001 has 5 settlements
  });

  it('returns empty settlements when offset exceeds total', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=20&offset=100`,
      { headers: { Authorization: 'Bearer dev-token-1' } },
    );
    const body = await res.json();

    assert.equal(body.settlements.length, 0);
    assert.equal(body.pagination.total, 5);
  });

  it('uses default limit=20 and offset=0 when params are omitted', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer dev-token-1' },
    });
    const body = await res.json();

    assert.equal(body.pagination.limit, 20);
    assert.equal(body.pagination.offset, 0);
  });

  it('clamps limit to 100 when a larger value is given', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=999`,
      { headers: { Authorization: 'Bearer dev-token-1' } },
    );
    const body = await res.json();

    assert.equal(body.pagination.limit, 100);
  });
});
