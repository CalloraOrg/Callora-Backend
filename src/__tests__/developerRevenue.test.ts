import express from 'express';
import type { Server } from 'node:http';
import { createDeveloperRouter } from '../routes/developerRoutes.js';
import { createSettlementStore } from '../services/settlementStore.js';
import { createUsageStore } from '../services/usageStore.js';
import { SettlementStore } from '../types/developer.js';
import { UsageStore } from '../types/gateway.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let settlementStore: SettlementStore;
let usageStore: UsageStore;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/developers', createDeveloperRouter({ settlementStore, usageStore }));
  return app;
}

let server: Server;
let baseUrl: string;

function seedData() {
  settlementStore.create({
    id: 'stl_001',
    developerId: 'dev_001',
    amount: 250.0,
    status: 'completed',
    tx_hash: '0xabc123def456',
    created_at: '2026-01-15T10:30:00Z',
  });
  settlementStore.create({
    id: 'stl_002',
    developerId: 'dev_001',
    amount: 175.5,
    status: 'completed',
    tx_hash: '0xdef789abc012',
    created_at: '2026-01-22T14:00:00Z',
  });
  settlementStore.create({
    id: 'stl_003',
    developerId: 'dev_001',
    amount: 320.0,
    status: 'pending',
    tx_hash: null,
    created_at: '2026-02-01T09:15:00Z',
  });
  settlementStore.create({
    id: 'stl_004',
    developerId: 'dev_001',
    amount: 90.0,
    status: 'failed',
    tx_hash: '0xfailed00001',
    created_at: '2026-02-10T16:45:00Z',
  });
  settlementStore.create({
    id: 'stl_005',
    developerId: 'dev_001',
    amount: 410.25,
    status: 'pending',
    tx_hash: null,
    created_at: '2026-02-20T11:00:00Z',
  });
  settlementStore.create({
    id: 'stl_010',
    developerId: 'dev_002',
    amount: 500.0,
    status: 'completed',
    tx_hash: '0x111222333aaa',
    created_at: '2026-02-05T08:00:00Z',
  });

  // Seed usage store with the mock "available to withdraw" (120 for dev_001)
  usageStore.record({
    id: 'evt_1',
    requestId: 'req_1',
    apiKey: 'key',
    apiKeyId: 'key',
    apiId: 'api_1',
    endpointId: 'ep_1',
    userId: 'dev_001',
    amountUsdc: 120.0,
    statusCode: 200,
    timestamp: new Date().toISOString(),
  });
}

beforeAll(() => {
  settlementStore = createSettlementStore();
  usageStore = createUsageStore();
  seedData();

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
      headers: { Authorization: 'Bearer dev-token-1' }, // implicitly mock-auths dev_001
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

    // dev_001: completed = 250 + 175.5 = 425.5, unsettled usage = 120, pending = 320 + 410.25 = 730.25
    // total_earned = 425.5 + 120 + 730.25 = 1275.75
    expect(body.summary.available_to_withdraw).toBe(120);
    expect(body.summary.pending).toBe(730.25);
    expect(body.summary.total_earned).toBe(425.5 + 120 + 730.25);
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
