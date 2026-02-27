import express from 'express';
import type { Server } from 'node:http';
import { createProxyRouter } from '../routes/proxyRoutes.js';
import { MockSorobanBilling } from '../services/billingService.js';
import { InMemoryRateLimiter } from '../services/rateLimiter.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { ApiKey, ApiRegistryEntry, ProxyConfig } from '../types/gateway.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

const TEST_API_KEY = 'metering-test-key';
const TEST_DEVELOPER_ID = 'dev_metering';
const TEST_API_ID = 'api_metering';
const TEST_API_SLUG = 'meter-test';

const apiKeys = new Map<string, ApiKey>([
  [TEST_API_KEY, { key: TEST_API_KEY, developerId: TEST_DEVELOPER_ID, apiId: TEST_API_ID }],
]);

// ── Mock upstream ───────────────────────────────────────────────────────────

let upstreamServer: Server;
let upstreamUrl: string;
let upstreamHandler: (req: express.Request, res: express.Response) => void;

function setUpstreamHandler(handler: (req: express.Request, res: express.Response) => void) {
  upstreamHandler = handler;
}

// ── App under test ──────────────────────────────────────────────────────────

let proxyServer: Server;
let proxyUrl: string;
let billing: MockSorobanBilling;
let rateLimiter: InMemoryRateLimiter;
let usageStore: InMemoryUsageStore;
let currentProxyConfig: Partial<ProxyConfig> = {};

async function startProxy() {
  if (proxyServer) {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  }

  const app = express();
  app.use(express.json());

  const registryEntry: ApiRegistryEntry = {
    id: TEST_API_ID,
    slug: TEST_API_SLUG,
    base_url: upstreamUrl,
    developerId: TEST_DEVELOPER_ID,
    endpoints: [
      { endpointId: 'ep_data', path: '/data', priceUsdc: 0.05 },
      { endpointId: 'ep_free', path: '/free', priceUsdc: 0 },
      { endpointId: 'ep_default', path: '*', priceUsdc: 0.01 },
    ],
  };
  const registry = new InMemoryApiRegistry([registryEntry]);

  const proxyRouter = createProxyRouter({
    billing,
    rateLimiter,
    usageStore,
    registry,
    apiKeys,
    proxyConfig: currentProxyConfig,
  });
  app.use('/v1/call', proxyRouter);

  await new Promise<void>((resolve) => {
    proxyServer = app.listen(0, () => {
      const addr = proxyServer.address();
      if (addr && typeof addr === 'object') {
        proxyUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    const upstream = express();
    upstream.use(express.json());
    upstream.all('*', (req, res) => {
      upstreamHandler(req, res);
    });
    upstreamServer = upstream.listen(0, () => {
      const addr = upstreamServer.address();
      if (addr && typeof addr === 'object') {
        upstreamUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });

  billing = new MockSorobanBilling({ [TEST_DEVELOPER_ID]: 1000 });
  rateLimiter = new InMemoryRateLimiter(100, 60_000);
  usageStore = new InMemoryUsageStore();

  await startProxy();
});

afterAll(async () => {
  if (proxyServer) await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  if (upstreamServer) await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

beforeEach(async () => {
  usageStore.clear();
  billing.setBalance(TEST_DEVELOPER_ID, 1000);
  rateLimiter.reset();
  currentProxyConfig = { timeoutMs: 2000 };
  await startProxy();

  setUpstreamHandler((_req, res) => {
    res.status(200).json({ message: 'upstream OK' });
  });
});

/** Helper to wait for the next event loop tick so non-blocking setImmediate tasks finish */
const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Usage Metering & Billing (Post-Proxy)', () => {
  it('deducts the correct endpoint price and records enriched usage event on 200 OK', async () => {
    // /data costs 0.05
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(200);

    await yieldTick(); // wait for background recording

    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);

    // Verify enriched fields
    const event = events[0];
    expect(event.endpointId).toBe('ep_data');
    expect(event.amountUsdc).toBe(0.05);
    expect(event.userId).toBe(TEST_DEVELOPER_ID);
    expect(event.requestId).toBeTruthy();

    const responseRequestId = res.headers.get('x-request-id');
    expect(event.requestId).toBe(responseRequestId);

    // Verify billing deduction: 1000 - 0.05 = 999.95
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBeCloseTo(999.95);
  });

  it('uses default wildcard path pricing if exact path not found', async () => {
    // /unknown falls back to '*' which costs 0.01
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/unknown`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(200);

    await yieldTick();

    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].endpointId).toBe('ep_default');
    expect(events[0].amountUsdc).toBe(0.01);

    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBeCloseTo(999.99);
  });

  it('records event but skips billing deduction if price is 0', async () => {
    // /free costs 0
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/free`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(200);

    await yieldTick();

    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].endpointId).toBe('ep_free');
    expect(events[0].amountUsdc).toBe(0);

    // Balance should remain unchanged
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(1000);
  });

  it('by default, does NOT record usage or deduct billing on 500 error', async () => {
    setUpstreamHandler((_req, res) => {
      res.status(500).json({ error: 'Internal Error' });
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(500);

    await yieldTick();

    // No event recorded
    expect(usageStore.getEvents()).toHaveLength(0);
    // Balance untouched
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(1000);
  });

  it('records usage on 500 if configured in recordableStatuses', async () => {
    currentProxyConfig = { timeoutMs: 2000, recordableStatuses: () => true };
    await startProxy();

    setUpstreamHandler((_req, res) => {
      res.status(500).json({ error: 'Internal Error' });
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(500);

    await yieldTick();

    // Event IS recorded due to override
    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].statusCode).toBe(500);

    // Balance deducted for 500 because it was recorded
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBeCloseTo(999.95);
  });

  it('is idempotent: duplicate requestIds do not double-bill', async () => {
    // Simulate a case where proxy handles same request twice
    // (In reality this is handled by usageStore idempotency directly, so let's unit-test it)
    const event = {
      id: 'event-1',
      requestId: 'req-dup',
      apiKey: TEST_API_KEY,
      apiKeyId: TEST_API_KEY,
      apiId: TEST_API_ID,
      endpointId: 'ep_data',
      userId: TEST_DEVELOPER_ID,
      amountUsdc: 0.05,
      statusCode: 200,
      timestamp: new Date().toISOString()
    };

    // First record works
    const r1 = usageStore.record(event);
    expect(r1).toBe(true);

    // Second record fails/skips
    const r2 = usageStore.record(event);
    expect(r2).toBe(false);

    expect(usageStore.getEvents()).toHaveLength(1);
  });

  it('rejects proxy completely if initial balance is 0', async () => {
    billing.setBalance(TEST_DEVELOPER_ID, 0);

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/insufficient balance/i);

    await yieldTick();

    // No event recorded
    expect(usageStore.getEvents()).toHaveLength(0);
  });
});
