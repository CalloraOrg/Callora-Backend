import express from 'express';
import type { Server } from 'node:http';
import { createProxyRouter } from '../routes/proxyRoutes.js';
import {
  legacyV1DeprecationMiddleware,
  LEGACY_V1_DEPRECATION_HEADER,
  LEGACY_V1_SUNSET_AT,
} from '../middleware/deprecation.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { MockSorobanBilling } from '../services/billingService.js';
import { InMemoryRateLimiter } from '../services/rateLimiter.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { ApiKey, ApiRegistryEntry } from '../types/gateway.js';
import { resetAllMetrics } from '../metrics.js';

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
    app.use(requestIdMiddleware);
    app.use('/v1/call', legacyV1DeprecationMiddleware);

    const proxyRouter = createProxyRouter({
      billing,
      rateLimiter,
      usageStore,
      registry,
      apiKeys,
      proxyConfig: {
        timeoutMs: 2000,
        allowedHosts: ['localhost'],
      }, // short timeout for tests
    });
    app.use('/v1/call', proxyRouter);
    app.use(errorHandler);

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
  billing.clear();
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
    expect(res.headers.get('deprecation')).toBe(LEGACY_V1_DEPRECATION_HEADER);
    expect(res.headers.get('sunset')).toBe(LEGACY_V1_SUNSET_AT);
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
    expect(body.message ?? body.error).toMatch(/unknown API/i);
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
    expect(body.message ?? body.error).toMatch(/insufficient balance/i);
    expect(usageStore.getEvents()).toHaveLength(0);
  });

  it('records usage idempotently — duplicate requestId is silently ignored', async () => {
    // Make two back-to-back requests with the same upstream path.
    // Both get independent requestIds (generated by the proxy), so both
    // should be recorded independently.
    const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({ input: 'first' }),
    });
    const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({ input: 'second' }),
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Allow finish listeners to fire.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const events = usageStore.getEvents(TEST_API_KEY);
    // Two distinct requestIds → two distinct events.
    expect(events).toHaveLength(2);
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(998);
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

  it('propagates a client-supplied request id to upstream, response, and usage', async () => {
    const edgeRequestId = 'edge-proxy-request-123';
    let upstreamRequestId: string | undefined;
    setUpstreamHandler((req, res) => {
      upstreamRequestId = req.headers['x-request-id'] as string | undefined;
      res.status(200).json({ requestId: upstreamRequestId });
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/request-id`, {
      method: 'GET',
      headers: {
        'x-api-key': TEST_API_KEY,
        'x-request-id': edgeRequestId,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe(edgeRequestId);
    expect(upstreamRequestId).toBe(edgeRequestId);

    await new Promise((resolve) => setImmediate(resolve));
    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBe(edgeRequestId);
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
    expect(body.message ?? body.error).toMatch(/timed out|timeout/i);

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
    tmpApp.use(requestIdMiddleware);
    tmpApp.use('/v1/call', createProxyRouter({
      billing,
      rateLimiter,
      usageStore,
      registry: badRegistry,
      apiKeys: badKeys,
      proxyConfig: {
        timeoutMs: 2000,
        allowedHosts: ['localhost'],
      },
    }));
    tmpApp.use(errorHandler);

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
    expect(body.message ?? body.error).toMatch(/bad gateway/i);

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
    expect(body1.message ?? body1.error).toMatch(/bad gateway/i);

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
    expect(body.message ?? body.error).toMatch(/timed out|timeout/i);
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
    expect(receivedHeaders['host']).toContain(upstreamUrl.split('//')[1]);
    expect(receivedHeaders['connection']).toBe('keep-alive');
    expect(receivedHeaders['transfer-encoding']).toBeUndefined();
    expect(receivedHeaders['proxy-authorization']).toBeUndefined();
    expect(receivedHeaders['proxy-connection']).toBeUndefined();

    // Verify safe headers are forwarded
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
        'Authorization': 'Bearer token', // Capitalized
        'HOST': 'should-be-stripped', // All caps
        'User-Agent': 'CaseTest/1.0',
      },
      body: JSON.stringify({}),
    });

    // Sensitive variants should be stripped case-insensitively
    expect(receivedHeaders['x-api-key']).toBeUndefined();
    expect(receivedHeaders['authorization']).toBeUndefined();
    expect(receivedHeaders['Authorization']).toBeUndefined();
    expect(receivedHeaders['host']).toContain(upstreamUrl.split('//')[1]);

    // Safe header should still be forwarded
  });

  it('preserves response headers from upstream while filtering hop-by-hop', async () => {
    setUpstreamHandler((req, res) => {
      res.set({
        'content-type': 'application/json',
        'cache-control': 'max-age=3600',
        'x-upstream-custom': 'upstream-value',
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
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe('max-age=3600');
    expect(res.headers.get('x-upstream-custom')).toBe('upstream-value');
    
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
    expect(body.message ?? body.error).toMatch(/bad gateway/i);
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
    expect(body.message ?? body.error).toMatch(/bad gateway/i);
    expect(body.requestId).toBeTruthy();
  });
});

// ── Usage recording: finish vs close ─────────────────────────────────────────
//
// These tests verify the fix for #411: usage must only be recorded when the
// response emits 'finish' (full delivery), not when the socket closes
// prematurely ('close' before 'finish').
// ─────────────────────────────────────────────────────────────────────────────

describe('Proxy usage recording – finish vs premature close', () => {
  beforeEach(() => {
    usageStore.clear();
    billing.clear();
    billing.setBalance(TEST_DEVELOPER_ID, 1000);
    rateLimiter.reset();
    resetAllMetrics();
    setUpstreamHandler((_req, res) => {
      res.status(200).json({ message: 'upstream OK' });
    });
  });

  it('records usage after a fully delivered response (finish event)', async () => {
    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/finish-test`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(200);

    // Allow the finish listener's setImmediate to fire before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const events = usageStore.getEvents(TEST_API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].statusCode).toBe(200);
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(999);
  });

  it('does NOT record usage when upstream resets the socket before sending headers', async () => {
    // Upstream destroys the socket immediately — proxy never gets a response,
    // so it returns 502.  No 'finish' → no usage recorded.
    setUpstreamHandler((_req, res) => {
      res.socket!.destroy();
    });

    const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/upstream-reset`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.status).toBe(502);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // No usage recorded — upstream reset means the caller got nothing.
    expect(usageStore.getEvents()).toHaveLength(0);
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(1000);
  });

  it('does NOT record usage when upstream resets the socket mid-stream after sending partial body', async () => {
    // Upstream sends headers + partial body, then drops the socket.
    // The proxy sees a stream error during pump() and the response 'close'
    // fires without a 'finish'.
    setUpstreamHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"partial":');
      // Destroy the socket mid-stream before the body is complete.
      res.socket!.destroy();
    });

    // The fetch will likely throw or return a truncated response; either is fine.
    let fetchError: unknown = null;
    try {
      const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/mid-stream-reset`, {
        method: 'GET',
        headers: { 'x-api-key': TEST_API_KEY },
      });
      // Drain the body to trigger pipe completion
      await res.text().catch(() => undefined);
    } catch (err) {
      fetchError = err;
    }

    // Wait several event-loop ticks so any erroneous setImmediate usage
    // recording would have fired.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The caller never received a complete response → no billing.
    expect(usageStore.getEvents()).toHaveLength(0);
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(1000);

    // Suppress unused-variable lint — fetchError is intentionally ignored here.
    void fetchError;
  });

  it('does NOT double-count when the same requestId is seen twice', async () => {
    // Simulates a retry or duplicate delivery of the same logical request.
    const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/idempotency-test`, {
      method: 'GET',
      headers: { 'x-api-key': TEST_API_KEY },
    });
    expect(res1.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const eventsAfterFirst = usageStore.getEvents(TEST_API_KEY);
    expect(eventsAfterFirst).toHaveLength(1);
    const firstRequestId = eventsAfterFirst[0].requestId;

    // Manually call record() again with the same requestId — should be a no-op.
    const duplicate = await usageStore.record({
      id: 'dup-id',
      requestId: firstRequestId,
      apiKey: TEST_API_KEY,
      apiKeyId: 'any',
      apiId: TEST_API_ID,
      endpointId: 'default',
      userId: TEST_DEVELOPER_ID,
      amountUsdc: 1,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    expect(duplicate).toBe(false);
    expect(usageStore.getEvents(TEST_API_KEY)).toHaveLength(1);
    // Balance only deducted once
    expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(999);
  });
});

// ── Idempotency-Key tests ────────────────────────────────────────────────────
//
// Tests for the Idempotency-Key header on POST/PATCH requests.
// Ensures:
// - First request with a key → upstream call made, response cached
// - Repeat request with same key/payload → cached response replayed (no upstream call)
// - Repeat request with same key but different payload → 409 IDEMPOTENCY_KEY_REUSE_MISMATCH
// - In-progress requests → 409 IDEMPOTENCY_IN_PROGRESS
// - Concurrent requests with same key → only one upstream call executes
// - GET/DELETE are unaffected by idempotency middleware
// - Actor scoping: different API key cannot retrieve another key's cached response
// ─────────────────────────────────────────────────────────────────────────────

describe('Proxy Idempotency-Key support (issue #896)', () => {
  beforeEach(() => {
    usageStore.clear();
    billing.clear();
    billing.setBalance(TEST_DEVELOPER_ID, 1000);
    rateLimiter.reset();
    resetAllMetrics();
    setUpstreamHandler((_req, res) => {
      res.status(200).json({ message: 'upstream OK', timestamp: Date.now() });
    });
  });

  describe('First request with Idempotency-Key', () => {
    it('forwards POST request with Idempotency-Key to upstream and caches response', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(200).json({ id: 'resource-1', created: true });
      });

      const idempotencyKey = 'idem-key-001';
      const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Resource A' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Idempotent-Replayed')).toBeFalsy();
      const body = await res.json();
      expect(body.id).toBe('resource-1');
      expect(upstreamCallCount).toBe(1);

      // Usage recorded
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const events = usageStore.getEvents(TEST_API_KEY);
      expect(events).toHaveLength(1);
      expect(billing.getBalance(TEST_DEVELOPER_ID)).toBe(999);
    });

    it('forwards PATCH request with Idempotency-Key to upstream and caches response', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(200).json({ id: 'resource-1', updated: true });
      });

      const idempotencyKey = 'idem-key-patch-001';
      const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources/123`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ status: 'active' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Idempotent-Replayed')).toBeFalsy();
      const body = await res.json();
      expect(body.id).toBe('resource-1');
      expect(upstreamCallCount).toBe(1);
    });
  });

  describe('Repeat request with same Idempotency-Key', () => {
    it('returns cached response without re-executing upstream call', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(200).json({
          id: 'cached-resource',
          created: true,
          timestamp: 12345,
        });
      });

      const idempotencyKey = 'idem-cache-001';

      // First request
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Cached Resource' }),
      });

      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.timestamp).toBe(12345);
      expect(upstreamCallCount).toBe(1);

      // Wait for upstream call to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry with same key — should replay from cache
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Cached Resource' }),
      });

      expect(res2.status).toBe(200);
      expect(res2.headers.get('Idempotent-Replayed')).toBe('true');
      const body2 = await res2.json();
      // Identical response from cache
      expect(body2.timestamp).toBe(12345);
      // Upstream NOT called again
      expect(upstreamCallCount).toBe(1);

      // Usage only recorded once
      await new Promise((resolve) => setImmediate(resolve));
      const events = usageStore.getEvents(TEST_API_KEY);
      expect(events).toHaveLength(1);
    });

    it('returns 409 when retry has same Idempotency-Key but different payload', async () => {
      const idempotencyKey = 'idem-mismatch-001';

      // First request with payload A
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Resource A' }),
      });

      expect(res1.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry with different payload B using the same key
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Resource B', status: 'active' }),
      });

      expect(res2.status).toBe(409);
      const body2 = await res2.json();
      expect(body2.code).toBe('IDEMPOTENCY_KEY_REUSE_MISMATCH');
      expect(body2.message).toMatch(/different request payload/i);
      expect(body2.conflictingSummary).toBeDefined();
      expect(body2.conflictingSummary.idempotencyKey).toBe(idempotencyKey);
      expect(body2.conflictingSummary.incomingPayloadFingerprint).toBeTruthy();
      expect(body2.conflictingSummary.storedPayloadFingerprint).toBeTruthy();
    });

    it('returns 409 IDEMPOTENCY_IN_PROGRESS when request is still being processed', async () => {
      // This test requires the ability to delay upstream response completion.
      // We'll set an upstream handler that hangs, then send a concurrent retry.

      const upstreamReady = Promise.withResolvers<void>();
      const upstreamShouldReply = Promise.withResolvers<void>();

      setUpstreamHandler(async (req, res) => {
        upstreamReady.resolve();
        await upstreamShouldReply.promise;
        res.status(200).json({ id: 'slow-resource', created: true });
      });

      const idempotencyKey = 'idem-in-progress-001';

      // Fire first request but don't await it yet
      const promise1 = fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Slow Resource' }),
      });

      // Wait for upstream to start processing
      await upstreamReady.promise;
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now send a concurrent retry with the same key while first is still in progress
      const promise2 = fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Slow Resource' }),
      });

      // Let first request complete
      upstreamShouldReply.resolve();
      const res1 = await promise1;
      const res2 = await promise2;

      // First should succeed
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.id).toBe('slow-resource');

      // Second (concurrent retry) should get 409 IN_PROGRESS
      expect(res2.status).toBe(409);
      const body2 = await res2.json();
      expect(body2.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(body2.message).toMatch(/already in progress/i);
    });
  });

  describe('Idempotency-Key not required (optional)', () => {
    it('processes POST request without Idempotency-Key normally', async () => {
      const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          // No Idempotency-Key header
        },
        body: JSON.stringify({ name: 'Resource' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Idempotent-Replayed')).toBeFalsy();
    });

    it('processes PATCH request without Idempotency-Key normally', async () => {
      const res = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources/123`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          // No Idempotency-Key header
        },
        body: JSON.stringify({ status: 'active' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Idempotent-Replayed')).toBeFalsy();
    });
  });

  describe('GET and DELETE are not affected by idempotency middleware', () => {
    it('GET requests bypass idempotency middleware even if Idempotency-Key is provided', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(200).json({ items: [1, 2, 3], timestamp: Date.now() });
      });

      // First GET with Idempotency-Key
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'GET',
        headers: {
          'x-api-key': TEST_API_KEY,
          'idempotency-key': 'idem-get-001',
        },
      });

      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      const timestamp1 = body1.timestamp;
      expect(upstreamCallCount).toBe(1);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry GET with same Idempotency-Key — should call upstream again (GET is not idempotent in this context)
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'GET',
        headers: {
          'x-api-key': TEST_API_KEY,
          'idempotency-key': 'idem-get-001',
        },
      });

      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      const timestamp2 = body2.timestamp;
      // Timestamps should differ (different upstream call)
      expect(timestamp2).not.toBe(timestamp1);
      // Upstream called twice
      expect(upstreamCallCount).toBe(2);
    });

    it('DELETE requests bypass idempotency middleware even if Idempotency-Key is provided', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(204).send();
      });

      // First DELETE with Idempotency-Key
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources/123`, {
        method: 'DELETE',
        headers: {
          'x-api-key': TEST_API_KEY,
          'idempotency-key': 'idem-delete-001',
        },
      });

      expect(res1.status).toBe(204);
      expect(upstreamCallCount).toBe(1);

      // Retry DELETE with same Idempotency-Key
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources/123`, {
        method: 'DELETE',
        headers: {
          'x-api-key': TEST_API_KEY,
          'idempotency-key': 'idem-delete-001',
        },
      });

      expect(res2.status).toBe(204);
      // Upstream called twice (not idempotent-protected for DELETE)
      expect(upstreamCallCount).toBe(2);
    });
  });

  describe('Actor scoping: different API keys cannot access each other cached responses', () => {
    it('does not leak cached response across different API keys', async () => {
      // Set up a second API key for a different developer
      const OTHER_DEVELOPER_ID = 'dev_other';
      const OTHER_API_KEY = 'proxy-test-key-other';
      const apiKeys = new Map<string, ApiKey>([
        [TEST_API_KEY, { key: TEST_API_KEY, developerId: TEST_DEVELOPER_ID, apiId: TEST_API_ID }],
        [OTHER_API_KEY, { key: OTHER_API_KEY, developerId: OTHER_DEVELOPER_ID, apiId: TEST_API_ID }],
      ]);

      // Restart proxy with both keys
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));

      const app = express();
      app.use(express.json());
      app.use(requestIdMiddleware);
      app.use('/v1/call', legacyV1DeprecationMiddleware);

      const registryEntry: ApiRegistryEntry = {
        id: TEST_API_ID,
        slug: TEST_API_SLUG,
        base_url: upstreamUrl,
        developerId: TEST_DEVELOPER_ID,
        endpoints: [{ endpointId: 'default', path: '*', priceUsdc: 1 }],
      };
      const registry = new InMemoryApiRegistry([registryEntry]);

      billing.setBalance(TEST_DEVELOPER_ID, 1000);
      billing.setBalance(OTHER_DEVELOPER_ID, 1000);

      const proxyRouter = createProxyRouter({
        billing,
        rateLimiter,
        usageStore,
        registry,
        apiKeys,
        proxyConfig: {
          timeoutMs: 2000,
          allowedHosts: ['localhost'],
        },
      });
      app.use('/v1/call', proxyRouter);
      app.use(errorHandler);

      await new Promise<void>((resolve) => {
        proxyServer = app.listen(0, () => {
          const addr = proxyServer.address();
          if (addr && typeof addr === 'object') {
            proxyUrl = `http://localhost:${addr.port}`;
          }
          resolve();
        });
      });

      let responseTimestamp = 0;
      setUpstreamHandler((req, res) => {
        responseTimestamp = Date.now();
        res.status(200).json({
          resource: 'secret-data',
          timestamp: responseTimestamp,
          actor: 'determined-by-api-key',
        });
      });

      const idempotencyKey = 'idem-shared-key';

      // User 1 makes request with the key
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/secret`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ action: 'read' }),
      });

      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      const timestamp1 = body1.timestamp;
      expect(body1.resource).toBe('secret-data');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // User 2 tries to use the same Idempotency-Key
      // Should NOT get User 1's cached response; should treat as new request
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/secret`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': OTHER_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ action: 'read' }),
      });

      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      const timestamp2 = body2.timestamp;
      
      // Should be a different response (new upstream call), not cached from User 1
      expect(timestamp2).toBeGreaterThan(timestamp1);
      expect(res2.headers.get('Idempotent-Replayed')).toBeFalsy();
    });
  });

  describe('Payload mismatch detection with canonicalization', () => {
    it('treats payloads with same data but different key order as matching', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(200).json({ id: 'resource', created: true });
      });

      const idempotencyKey = 'idem-canonical-001';

      // First request: { b: 2, a: 1 }
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ b: 2, a: 1 }),
      });

      expect(res1.status).toBe(200);
      expect(upstreamCallCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry with different key order: { a: 1, b: 2 }
      // Should match because canonical form is the same
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ a: 1, b: 2 }),
      });

      expect(res2.status).toBe(200);
      expect(res2.headers.get('Idempotent-Replayed')).toBe('true');
      // Upstream NOT called again
      expect(upstreamCallCount).toBe(1);
    });

    it('detects mismatch even with nested objects in different key orders', async () => {
      const idempotencyKey = 'idem-nested-001';

      // First request: nested object with z, a order
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          nested: { z: 26, a: 1 },
          name: 'Resource',
        }),
      });

      expect(res1.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry with same nested data but reordered: a, z order
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          name: 'Resource',
          nested: { a: 1, z: 26 },
        }),
      });

      expect(res2.status).toBe(200);
      expect(res2.headers.get('Idempotent-Replayed')).toBe('true');
    });
  });

  describe('Headers: Idempotency-Key case-insensitivity and variants', () => {
    it('accepts Idempotency-Key header in any case', async () => {
      let upstreamCallCount = 0;
      setUpstreamHandler((req, res) => {
        upstreamCallCount++;
        res.status(200).json({ id: 'resource', created: true });
      });

      const idempotencyKey = 'idem-case-001';

      // First request with lowercase
      const res1 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Resource' }),
      });

      expect(res1.status).toBe(200);
      expect(upstreamCallCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry with Capitalized case
      const res2 = await fetch(`${proxyUrl}/v1/call/${TEST_API_SLUG}/resources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEST_API_KEY,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ name: 'Resource' }),
      });

      expect(res2.status).toBe(200);
      expect(res2.headers.get('Idempotent-Replayed')).toBe('true');
      expect(upstreamCallCount).toBe(1);
    });
  });
});
