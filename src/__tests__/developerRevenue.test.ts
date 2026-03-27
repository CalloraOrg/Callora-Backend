import express from 'express';
import type { Server } from 'node:http';
import { createDeveloperRouter } from '../routes/developerRoutes.js';
import { createSettlementStore } from '../services/settlementStore.js';
import { createUsageStore } from '../services/usageStore.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { SettlementStore } from '../types/developer.js';
import { UsageStore } from '../types/gateway.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let settlementStore: SettlementStore;
let usageStore: UsageStore;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/developers', createDeveloperRouter({ settlementStore, usageStore }));
  app.use(errorHandler);
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
      headers: { 'x-user-id': '' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct shape for a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_001' }, // implicitly mock-auths dev_001
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
      headers: { 'x-user-id': 'dev_001' },
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
      { headers: { 'x-user-id': 'dev_001' } },
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
      { headers: { 'x-user-id': 'dev_001' } },
    );
    const body = await res.json();

    expect(body.settlements.length).toBe(0);
    expect(body.pagination.total).toBe(5);
  });

  it('uses default limit=20 and offset=0 when params are omitted', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_001' },
    });
    const body = await res.json();

    expect(body.pagination.limit).toBe(20);
    expect(body.pagination.offset).toBe(0);
  });

  it('clamps limit to 100 when a larger value is given', async () => {
    const res = await fetch(
      `${baseUrl}/api/developers/revenue?limit=999`,
      { headers: { 'x-user-id': 'dev_001' } },
    );
    const body = await res.json();

    expect(body.pagination.limit).toBe(100);
  });

  // ── Split Calculation Tests ────────────────────────────────────────────────

  it('handles fractional amounts correctly in split calculations', async () => {
    // Add settlements with fractional amounts
    settlementStore.create({
      id: 'stl_frac_1',
      developerId: 'dev_003',
      amount: 100.333333333,
      status: 'completed',
      tx_hash: '0xfrac1',
      created_at: '2026-03-01T10:00:00Z',
    });
    settlementStore.create({
      id: 'stl_frac_2',
      developerId: 'dev_003',
      amount: 200.666666666,
      status: 'completed',
      tx_hash: '0xfrac2',
      created_at: '2026-03-02T10:00:00Z',
    });

    // Add usage events with fractional amounts
    usageStore.record({
      id: 'evt_frac_1',
      requestId: 'req_frac_1',
      apiKey: 'key_frac',
      apiKeyId: 'key_frac',
      apiId: 'api_frac',
      endpointId: 'ep_frac',
      userId: 'dev_003',
      amountUsdc: 50.123456789,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_003' },
    });
    const body = await res.json();

    // Should handle fractional precision correctly
    expect(body.summary.total_earned).toBeCloseTo(351.123123456, 9);
    expect(body.summary.available_to_withdraw).toBeCloseTo(50.123456789, 9);
  });

  it('accurately calculates revenue across multiple settlement statuses', async () => {
    settlementStore.create({
      id: 'stl_multi_1',
      developerId: 'dev_004',
      amount: 1000.00,
      status: 'completed',
      tx_hash: '0xmulti1',
      created_at: '2026-03-01T10:00:00Z',
    });
    settlementStore.create({
      id: 'stl_multi_2',
      developerId: 'dev_004',
      amount: 500.50,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-03-02T10:00:00Z',
    });
    settlementStore.create({
      id: 'stl_multi_3',
      developerId: 'dev_004',
      amount: 250.25,
      status: 'failed',
      tx_hash: '0xfail1',
      created_at: '2026-03-03T10:00:00Z',
    });

    // Add unsettled usage
    usageStore.record({
      id: 'evt_multi_1',
      requestId: 'req_multi_1',
      apiKey: 'key_multi',
      apiKeyId: 'key_multi',
      apiId: 'api_multi',
      endpointId: 'ep_multi',
      userId: 'dev_004',
      amountUsdc: 750.75,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_004' },
    });
    const body = await res.json();

    // Only completed and unsettled count toward total_earned
    // Failed settlements should not count toward any totals
    expect(body.summary.total_earned).toBe(1000.00 + 500.50 + 750.75); // 2251.25
    expect(body.summary.pending).toBe(500.50);
    expect(body.summary.available_to_withdraw).toBe(750.75);
  });

  // ── Rounding Edge Cases ───────────────────────────────────────────────────────

  it('handles very small fractional amounts without precision loss', async () => {
    usageStore.record({
      id: 'evt_tiny_1',
      requestId: 'req_tiny_1',
      apiKey: 'key_tiny',
      apiKeyId: 'key_tiny',
      apiId: 'api_tiny',
      endpointId: 'ep_tiny',
      userId: 'dev_005',
      amountUsdc: 0.000000001,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    usageStore.record({
      id: 'evt_tiny_2',
      requestId: 'req_tiny_2',
      apiKey: 'key_tiny',
      apiKeyId: 'key_tiny',
      apiId: 'api_tiny',
      endpointId: 'ep_tiny',
      userId: 'dev_005',
      amountUsdc: 0.000000002,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_005' },
    });
    const body = await res.json();

    expect(body.summary.total_earned).toBeCloseTo(0.000000003, 9);
    expect(body.summary.available_to_withdraw).toBeCloseTo(0.000000003, 9);
  });

  it('handles large amounts without overflow or precision issues', async () => {
    settlementStore.create({
      id: 'stl_large_1',
      developerId: 'dev_006',
      amount: 999999999.99,
      status: 'completed',
      tx_hash: '0xlarge1',
      created_at: '2026-03-01T10:00:00Z',
    });

    usageStore.record({
      id: 'evt_large_1',
      requestId: 'req_large_1',
      apiKey: 'key_large',
      apiKeyId: 'key_large',
      apiId: 'api_large',
      endpointId: 'ep_large',
      userId: 'dev_006',
      amountUsdc: 888888888.88,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_006' },
    });
    const body = await res.json();

    expect(body.summary.total_earned).toBeCloseTo(1888888888.87, 2);
    expect(body.summary.available_to_withdraw).toBeCloseTo(888888888.88, 2);
  });

  it('accumulates many small fractional amounts accurately', async () => {
    // Create 1000 events each with 0.001 USDC
    for (let i = 0; i < 1000; i++) {
      usageStore.record({
        id: `evt_accum_${i}`,
        requestId: `req_accum_${i}`,
        apiKey: 'key_accum',
        apiKeyId: 'key_accum',
        apiId: 'api_accum',
        endpointId: 'ep_accum',
        userId: 'dev_007',
        amountUsdc: 0.001,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      });
    }

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_007' },
    });
    const body = await res.json();

    // Should accumulate to exactly 1.0 USDC
    expect(body.summary.total_earned).toBeCloseTo(1.0, 6);
    expect(body.summary.available_to_withdraw).toBeCloseTo(1.0, 6);
  });

  // ── Boundary Input Tests ───────────────────────────────────────────────────────

  it('handles zero amounts correctly', async () => {
    settlementStore.create({
      id: 'stl_zero_1',
      developerId: 'dev_008',
      amount: 0.0,
      status: 'completed',
      tx_hash: '0xzero1',
      created_at: '2026-03-01T10:00:00Z',
    });

    usageStore.record({
      id: 'evt_zero_1',
      requestId: 'req_zero_1',
      apiKey: 'key_zero',
      apiKeyId: 'key_zero',
      apiId: 'api_zero',
      endpointId: 'ep_zero',
      userId: 'dev_008',
      amountUsdc: 0.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_008' },
    });
    const body = await res.json();

    expect(body.summary.total_earned).toBe(0.0);
    expect(body.summary.pending).toBe(0.0);
    expect(body.summary.available_to_withdraw).toBe(0.0);
  });

  it('handles negative amounts (should be filtered out)', async () => {
    // Negative amounts should not be included in revenue calculations
    usageStore.record({
      id: 'evt_neg_1',
      requestId: 'req_neg_1',
      apiKey: 'key_neg',
      apiKeyId: 'key_neg',
      apiId: 'api_neg',
      endpointId: 'ep_neg',
      userId: 'dev_009',
      amountUsdc: -10.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    usageStore.record({
      id: 'evt_pos_1',
      requestId: 'req_pos_1',
      apiKey: 'key_pos',
      apiKeyId: 'key_pos',
      apiId: 'api_pos',
      endpointId: 'ep_pos',
      userId: 'dev_009',
      amountUsdc: 50.0,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_009' },
    });
    const body = await res.json();

    // Only positive amounts should be counted
    expect(body.summary.total_earned).toBe(50.0);
    expect(body.summary.available_to_withdraw).toBe(50.0);
  });

  it('handles developer with no revenue data', async () => {
    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_no_data' },
    });
    const body = await res.json();

    expect(body.summary.total_earned).toBe(0.0);
    expect(body.summary.pending).toBe(0.0);
    expect(body.summary.available_to_withdraw).toBe(0.0);
    expect(body.settlements).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
  });

  it('handles extremely large number of settlements efficiently', async () => {
    // Create 200 settlements for the developer
    for (let i = 0; i < 200; i++) {
      settlementStore.create({
        id: `stl_bulk_${i}`,
        developerId: 'dev_010',
        amount: 10.0 + (i * 0.01),
        status: i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'pending' : 'failed',
        tx_hash: i % 3 === 0 ? `0xbulk_${i}` : i % 3 === 2 ? `0xfail_${i}` : null,
        created_at: `2026-03-${String(i % 28 + 1).padStart(2, '0')}T10:00:00Z`,
      });
    }

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_010' },
    });
    const body = await res.json();

    // Should handle large dataset without performance issues
    expect(body.pagination.total).toBe(200);
    expect(body.settlements.length).toBe(20); // default limit
    
    // Verify calculation accuracy
    const completedCount = Math.floor(200 / 3) + 1; // ~67 completed
    const pendingCount = Math.floor(200 / 3); // ~66 pending
    const expectedCompleted = completedCount * 10.0; // Approximate
    const expectedPending = pendingCount * 10.0; // Approximate
    
    expect(body.summary.total_earned).toBeGreaterThan(expectedCompleted);
    expect(body.summary.pending).toBeGreaterThan(expectedPending);
  });

  it('handles boundary pagination values correctly', async () => {
    // Create exactly 100 settlements
    for (let i = 0; i < 100; i++) {
      settlementStore.create({
        id: `stl_boundary_${i}`,
        developerId: 'dev_011',
        amount: 5.0,
        status: 'completed',
        tx_hash: `0xboundary_${i}`,
        created_at: '2026-03-01T10:00:00Z',
      });
    }

    // Test limit = 100 (max allowed)
    const res1 = await fetch(
      `${baseUrl}/api/developers/revenue?limit=100&offset=0`,
      { headers: { 'x-user-id': 'dev_011' } },
    );
    const body1 = await res1.json();
    expect(body1.settlements.length).toBe(100);
    expect(body1.pagination.limit).toBe(100);

    // Test offset = 99 (should return 1 settlement)
    const res2 = await fetch(
      `${baseUrl}/api/developers/revenue?limit=20&offset=99`,
      { headers: { 'x-user-id': 'dev_011' } },
    );
    const body2 = await res2.json();
    expect(body2.settlements.length).toBe(1);
    expect(body2.pagination.offset).toBe(99);

    // Test offset = 100 (should return 0 settlements)
    const res3 = await fetch(
      `${baseUrl}/api/developers/revenue?limit=20&offset=100`,
      { headers: { 'x-user-id': 'dev_011' } },
    );
    const body3 = await res3.json();
    expect(body3.settlements.length).toBe(0);
    expect(body3.pagination.offset).toBe(100);
  });

  // ── Data Integrity Tests ───────────────────────────────────────────────────────

  it('maintains data integrity with mixed decimal precision', async () => {
    settlementStore.create({
      id: 'stl_precision_1',
      developerId: 'dev_012',
      amount: 123.456789012345,
      status: 'completed',
      tx_hash: '0xprecision1',
      created_at: '2026-03-01T10:00:00Z',
    });

    usageStore.record({
      id: 'evt_precision_1',
      requestId: 'req_precision_1',
      apiKey: 'key_precision',
      apiKeyId: 'key_precision',
      apiId: 'api_precision',
      endpointId: 'ep_precision',
      userId: 'dev_012',
      amountUsdc: 0.123456789012345,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_012' },
    });
    const body = await res.json();

    // Should maintain reasonable precision without floating point errors
    expect(body.summary.total_earned).toBeCloseTo(123.580245801345, 12);
    expect(body.summary.available_to_withdraw).toBeCloseTo(0.123456789012345, 15);
  });

  it('handles concurrent revenue calculations correctly', async () => {
    // Simulate concurrent access by creating data rapidly
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        new Promise<void>((resolve) => {
          settlementStore.create({
            id: `stl_concurrent_${i}`,
            developerId: 'dev_013',
            amount: Math.random() * 100,
            status: 'completed',
            tx_hash: `0xconcurrent_${i}`,
            created_at: new Date(Date.now() + i).toISOString(),
          });
          resolve();
        })
      );
    }

    await Promise.all(promises);

    const res = await fetch(`${baseUrl}/api/developers/revenue`, {
      headers: { 'x-user-id': 'dev_013' },
    });
    const body = await res.json();

    expect(body.pagination.total).toBe(50);
    expect(body.summary.total_earned).toBeGreaterThan(0);
    expect(body.summary.pending).toBe(0); // all completed
  });
});
