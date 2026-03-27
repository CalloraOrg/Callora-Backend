import express from 'express';
import type { Server } from 'node:http';
import { createProxyRouter } from '../routes/proxyRoutes.js';
import { MockSorobanBilling } from '../services/billingService.js';
import { InMemoryRateLimiter } from '../services/rateLimiter.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { ApiKey, ApiRegistryEntry } from '../types/gateway.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

const TEST_API_KEY = 'proxy-test-key';
const TEST_DEVELOPER_ID = 'dev_proxy';
const TEST_API_ID = 'api_proxy';
const TEST_API_SLUG = 'test-proxy-api';

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

// ── Proxy app under test ────────────────────────────────────────────────────

let proxyServer: Server;
let proxyUrl: string;
let billing: MockSorobanBilling;
let rateLimiter: InMemoryRateLimiter;
let usageStore: InMemoryUsageStore;

beforeAll(async () => {
  // Start mock upstream
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

  // Default upstream handler
  setUpstreamHandler((_req, res) => {
    res.status(200).json({ message: 'upstream OK', items: [1, 2, 3] });
  });

  // Build registry with upstream URL
  const registryEntry: ApiRegistryEntry = {
    id: TEST_API_ID,
    slug: TEST_API_SLUG,
    base_url: upstreamUrl,
    developerId: TEST_DEVELOPER_ID,
    endpoints: [{ endpointId: 'default', path: '*', priceUsdc: 1 }],
  };
  const registry = new InMemoryApiRegistry([registryEntry]);

  billing = new MockSorobanBilling({ [TEST_DEVELOPER_ID]: 1000 });
  rateLimiter = new InMemoryRateLimiter(100, 60_000);
  usageStore = new InMemoryUsageStore();

  // Start proxy gateway
  await new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());

    const proxyRouter = createProxyRouter({
      billing,
      rateLimiter,
      usageStore,
      registry,
      apiKeys,
      proxyConfig: { timeoutMs: 2000 }, // short timeout for tests
    });
    app.use('/v1/call', proxyRouter);

    proxyServer = app.listen(0, () => {
      const addr = proxyServer.address();
      if (addr && typeof addr === 'object') {
        proxyUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

beforeEach(() => {
  usageStore.clear();
  billing.setBalance(TEST_DEVELOPER_ID, 1000);
  rateLimiter.reset();
  setUpstreamHandler((_req, res) => {
    res.status(200).json({ message: 'upstream OK', items: [1, 2, 3] });
  });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Proxy /v1/call', () => {
  it('proxies a valid request by slug and returns upstream response', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({ input: 'hello' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('upstream OK');
    expect(body.items).toEqual([1, 2, 3]);

    // Usage recorded
    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].apiId).toBe(TEST_API_ID);
    expect(events[0].statusCode).toBe(200);

    // Billing deducted
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(999);
  });

  it('proxies a valid request by ID', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_ID}/ping`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown slug/ID', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/unknown-api/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/unknown API/i);
  });

  it('returns 401 when API key is missing', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid API key', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 402 when balance is insufficient', async () => {
    billing.setBalance(TEST_DEVELOPER_ID, 0);

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/insufficient balance/i);
    expect(usageStore.getEvents()).toHaveLength(0);
  });

  it('returns 429 when rate limited', async () => {
    rateLimiter.exhaust(TEST_API_KEY);

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('retry-after');
    expect(retryAfter).toBeTruthy();
    expect(usageStore.getEvents()).toHaveLength(0);
  });

  it('includes X-Request-Id in the response', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    // UUID v4 format
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('strips internal headers from the upstream request', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    setUpstreamHandler((req, res) => {
      receivedHeaders = { ...req.headers };
      res.status(200).json({ ok: true });
    });

    await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TEST_API_KEY,
        'x-custom': 'should-forward',
      },
      body: JSON.stringify({}),
    });

    // Internal headers should be stripped
    expect(receivedHeaders['x-api-key']).toBeUndefined();
    // host is always set by fetch to the target — verify it's the upstream's, not the proxy's
    expect(receivedHeaders['host']).toContain(upstreamUrl.split('//')[1]);
    // Custom header should be forwarded
    expect(receivedHeaders['x-custom']).toBe('should-forward');
    // X-Request-Id should be added
    expect(receivedHeaders['x-request-id']).toBeTruthy();
  });

  it('forwards wildcard path to upstream', async () => {
    let receivedPath = '';

    setUpstreamHandler((req, res) => {
      receivedPath = req.path;
      res.status(200).json({ path: req.path });
    });

    await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/foo/bar/baz`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(receivedPath).toBe('/foo/bar/baz');
  });

  it('returns 504 on upstream timeout', async () => {
    setUpstreamHandler((_req, _res) => {
      // Don't respond — let it hang until timeout
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/slow`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toMatch(/timeout/i);

    await new Promise((resolve) => setImmediate(resolve));

    // Under the new config (2xx only), a 504 is NOT recorded by default
    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(0);
  });

  it('returns 502 when upstream is unreachable', async () => {
    // Point to a port nothing is listening on
    const badRegistry = new InMemoryApiRegistry([{
      id: 'api_bad',
      slug: 'bad-api',
      base_url: 'http://localhost:1',
      developerId: TEST_DEVELOPER_ID,
      endpoints: [{ endpointId: 'default', path: '*', priceUsdc: 1 }],
    }]);
    const badKeys = new Map<string, ApiKey>([
      ['bad-key', { key: 'bad-key', developerId: TEST_DEVELOPER_ID, apiId: 'api_bad' }],
    ]);

    // Spin up a temporary proxy with the bad registry
    const tmpApp = express();
    tmpApp.use(express.json());
    tmpApp.use('/v1/call', createProxyRouter({
      billing,
      rateLimiter,
      usageStore,
      registry: badRegistry,
      apiKeys: badKeys,
      proxyConfig: { timeoutMs: 2000 },
    }));

    const tmpServer = await new Promise<Server>((resolve) => {
      const s = tmpApp.listen(0, () => resolve(s));
    });
    const tmpAddr = tmpServer.address();
    const tmpUrl = tmpAddr && typeof tmpAddr === 'object'
      ? `http://localhost:${tmpAddr.port}`
      : '';

    const res = await fetch(`${tmpUrl}/v1/call/bad-api/data`, {
      method: 'GET',
      headers: { 'x-api-key': 'bad-key' },
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/bad gateway/i);

    await new Promise<void>((resolve) => tmpServer.close(() => resolve()));
  });
});

// ── Resilience Tests ──────────────────────────────────────────────────────

describe('Proxy Resilience', () => {
  it('handles connection resets gracefully', async () => {
    let requestCount = 0;
    
    setUpstreamHandler((req, res) => {
      requestCount++;
      // Reset connection on first request
      if (requestCount === 1) {
        res.socket!.destroy();
        return;
      }
      // Succeed on retry
      res.status(200).json({ message: 'success after reset', requestCount });
    });

    // First request should fail with connection reset
    const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/reset-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({ test: 'reset' }),
    });

    expect(res1.status).toBe(502);
    const body1 = await res1.json();
    expect(body1.error).toMatch(/bad gateway/i);

    // Second request should succeed
    const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/reset-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({ test: 'reset' }),
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.message).toBe('success after reset');
    expect(body2.requestCount).toBe(2);
  });

  it('handles slow upstreams with timeout', async () => {
    setUpstreamHandler(async (req, res) => {
      // Simulate slow response that exceeds timeout
      await new Promise(resolve => setTimeout(resolve, 3000));
      res.status(200).json({ message: 'too late' });
    });

    const startTime = Date.now();
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/slow`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    const duration = Date.now() - startTime;
    
    // Should timeout before 3 seconds (proxy timeout is 2000ms)
    expect(duration).toBeLessThan(3000);
    expect(res.status).toBe(504);
    
    const body = await res.json();
    expect(body.error).toMatch(/timeout/i);
    expect(body.requestId).toBeTruthy();
  });

  it('handles upstream that responds slowly but within timeout', async () => {
    setUpstreamHandler(async (req, res) => {
      // Respond within timeout (1.5 seconds, timeout is 2 seconds)
      await new Promise(resolve => setTimeout(resolve, 1500));
      res.status(200).json({ message: 'slow but success' });
    });

    const startTime = Date.now();
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/slow-but-ok`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    const duration = Date.now() - startTime;
    
    // Should complete within timeout
    expect(duration).toBeGreaterThan(1500);
    expect(duration).toBeLessThan(3000);
    expect(res.status).toBe(200);
    
    const body = await res.json();
    expect(body.message).toBe('slow but success');
  });

  it('prevents sensitive header leakage to upstream', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    setUpstreamHandler((req, res) => {
      receivedHeaders = { ...req.headers };
      res.status(200).json({ receivedHeaders: Object.keys(receivedHeaders) });
    });

    await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/security-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TEST_API_KEY,
        'authorization': 'Bearer secret-token',
        'cookie': 'session=abc123',
        'x-forwarded-for': '192.168.1.1',
        'x-real-ip': '192.168.1.1',
        'x-custom-safe': 'should-forward',
        'user-agent': 'TestAgent/1.0',
      },
      body: JSON.stringify({}),
    });

    // Verify sensitive headers are stripped
    expect(receivedHeaders['x-api-key']).toBeUndefined();
    expect(receivedHeaders['authorization']).toBeUndefined();
    expect(receivedHeaders['cookie']).toBeUndefined();
    expect(receivedHeaders['x-forwarded-for']).toBeUndefined();
    expect(receivedHeaders['x-real-ip']).toBeUndefined();
    expect(receivedHeaders['host']).toBeUndefined();
    expect(receivedHeaders['connection']).toBeUndefined();
    expect(receivedHeaders['keep-alive']).toBeUndefined();
    expect(receivedHeaders['transfer-encoding']).toBeUndefined();
    expect(receivedHeaders['proxy-authorization']).toBeUndefined();
    expect(receivedHeaders['proxy-connection']).toBeUndefined();

    // Verify safe headers are forwarded
    expect(receivedHeaders['x-custom-safe']).toBe('should-forward');
    expect(receivedHeaders['user-agent']).toBe('TestAgent/1.0');
    expect(receivedHeaders['content-type']).toBe('application/json');
    
    // Verify X-Request-Id is added
    expect(receivedHeaders['x-request-id']).toBeTruthy();
    expect(receivedHeaders['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('handles case-insensitive header stripping', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    setUpstreamHandler((req, res) => {
      receivedHeaders = { ...req.headers };
      res.status(200).json({ ok: true });
    });

    await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/case-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TEST_API_KEY,
        'X-API-Key': 'should-be-stripped', // Uppercase variant
        'Authorization': 'Bearer token', // Capitalized
        'HOST': 'should-be-stripped', // All caps
        'x-custom-safe': 'should-forward',
      },
      body: JSON.stringify({}),
    });

    // All variants should be stripped (case-insensitive)
    expect(receivedHeaders['x-api-key']).toBeUndefined();
    expect(receivedHeaders['X-API-Key']).toBeUndefined();
    expect(receivedHeaders['authorization']).toBeUndefined();
    expect(receivedHeaders['Authorization']).toBeUndefined();
    expect(receivedHeaders['host']).toBeUndefined();
    expect(receivedHeaders['HOST']).toBeUndefined();

    // Safe header should still be forwarded
    expect(receivedHeaders['x-custom-safe']).toBe('should-forward');
  });

  it('preserves response headers from upstream while filtering hop-by-hop', async () => {
    setUpstreamHandler((req, res) => {
      res.set({
        'content-type': 'application/json',
        'cache-control': 'max-age=3600',
        'x-upstream-custom': 'upstream-value',
        'connection': 'close', // Should be filtered
        'transfer-encoding': 'chunked', // Should be filtered
        'x-request-id': 'upstream-id', // Should be overridden by proxy
      });
      res.status(200).json({ message: 'response with headers' });
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/headers-test`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(200);
    
    // Should preserve safe headers
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('max-age=3600');
    expect(res.headers.get('x-upstream-custom')).toBe('upstream-value');
    
    // Should filter hop-by-hop headers
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
    
    // Should override upstream request-id with proxy's
    expect(res.headers.get('x-request-id')).not.toBe('upstream-id');
    expect(res.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('handles upstream that closes connection prematurely', async () => {
    setUpstreamHandler((req, res) => {
      // Start response but close connection before finishing
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial": "response"');
      res.socket!.destroy();
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/premature-close`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    // Should handle gracefully with 502
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/bad gateway/i);
  });

  it('maintains request id through connection errors', async () => {
    setUpstreamHandler((req, res) => {
      // Destroy connection immediately
      res.socket!.destroy();
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/error-with-id`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/bad gateway/i);
    expect(body.requestId).toBeTruthy();
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
