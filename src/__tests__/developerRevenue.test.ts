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

beforeAll(() => {
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

afterAll(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/developers/revenue', () => {
  it('returns 401 when no auth token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 401 for an invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer bad-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct shape for a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer dev-token-1' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // summary
    expect(body).toHaveProperty('summary');
    expect(typeof body.summary.total_earned).toBe('number');
    expect(typeof body.summary.pending).toBe('number');
    expect(typeof body.summary.available_to_withdraw).toBe('number');

    // settlements array
    expect(Array.isArray(body.settlements)).toBe(true);
    expect(body.settlements.length).toBeGreaterThan(0);

    // pagination
    expect(body).toHaveProperty('pagination');
    expect(typeof body.pagination.limit).toBe('number');
    expect(typeof body.pagination.offset).toBe('number');
    expect(typeof body.pagination.total).toBe('number');
  });

  it('returns correct summary values for dev_001', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer dev-token-1' },
    });
    const body = await res.json();

    // dev_001: completed = 250 + 175.5 = 425.5, usage = 120 → total_earned = 545.5
    // pending = 320 + 410.25 = 730.25
    // available_to_withdraw = 545.5 - 730.25 = -184.75
    expect(body.summary.total_earned).toBe(545.5);
    expect(body.summary.pending).toBe(730.25);
    expect(body.summary.available_to_withdraw).toBe(545.5 - 730.25);
  });

  it('respects limit and offset query params', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=2&offset=0`,
      { headers: { Authorization: 'Bearer dev-token-1' } },
    );
    const body = await res.json();

    expect(body.settlements.length).toBe(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.offset).toBe(0);
    expect(body.pagination.total).toBe(5); // dev_001 has 5 settlements
  });

  it('returns empty settlements when offset exceeds total', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=20&offset=100`,
      { headers: { Authorization: 'Bearer dev-token-1' } },
    );
    const body = await res.json();

    expect(body.settlements.length).toBe(0);
    expect(body.pagination.total).toBe(5);
  });

  it('uses default limit=20 and offset=0 when params are omitted', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { Authorization: 'Bearer dev-token-1' },
    });
    const body = await res.json();

    expect(body.pagination.limit).toBe(20);
    expect(body.pagination.offset).toBe(0);
  });

  it('clamps limit to 100 when a larger value is given', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=999`,
      { headers: { Authorization: 'Bearer dev-token-1' } },
    );
    const body = await res.json();

    expect(body.pagination.limit).toBe(100);
  });
});
