import express from "express";
import request from "supertest";
import { createGatewayRouter } from "./gatewayRoutes.js";
import { createRateLimiter } from "../services/rateLimiter.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import type { ApiKey, GatewayDeps } from "../types/gateway.js";

describe("gateway route - rate limiting", () => {
  let now = 0;

  beforeEach(() => {
    now = new Date("2026-03-30T00:00:00.000Z").getTime();
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("returns 429 with Retry-After when rate limited", async () => {
    const apiKey = "test-key";
    const apiId = "my-api";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });

    const windowMs = 60_000;
    const rateLimiter = createRateLimiter(1, windowMs);
    // exhaust so the route sees a rate-limited result immediately
    rateLimiter.exhaust(apiKey);

    const deps = {
      billing: { deductCredit: async () => ({ success: true, balance: 100 }) },
      rateLimiter,
      usageStore: { record: () => {} },
      upstreamUrl: "http://example.invalid",
      apiKeys,
    } as unknown as GatewayDeps;

    const app = express();
    // The gateway router supplies its own body parser; no outer express.json() needed
    app.use(requestIdMiddleware);
    app.use("/gateway", createGatewayRouter(deps));
    app.use(errorHandler);

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set("x-api-key", apiKey);

    expect(res.status).toBe(429);
    // Retry-After header is in seconds, rounded up
    expect(res.headers["retry-after"]).toBe(String(Math.ceil(windowMs / 1000)));
    expect(res.body).toHaveProperty("code", "TOO_MANY_REQUESTS");
    expect(res.body).toHaveProperty("message", "Too Many Requests");
    expect(res.body).toHaveProperty("requestId");
  });
});

describe("gateway route - body size limits", () => {
  function buildApp(maxBodySize?: string) {
    const apiKey = "test-key";
    const apiId = "my-api";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });

    const deps = {
      billing: { deductCredit: async () => ({ success: true, balance: 100 }) },
      rateLimiter: { check: () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
      maxBodySize,
    } as unknown as GatewayDeps;

    const app = express();
    // No outer express.json() — the gateway router enforces its own limit
    app.use(requestIdMiddleware);
    app.use("/gateway", createGatewayRouter(deps));
    app.use(errorHandler);
    return { app, apiKey, apiId };
  }

  test("accepts POST bodies within the configured size limit", async () => {
    const apiKey = "test-key";
    const apiId = "my-api";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });

    const deps = {
      // Returning { success: false } causes a 402 before any upstream fetch,
      // keeping the test fast while still proving the body was parsed (not 413).
      billing: { deductCredit: async () => ({ success: false, balance: 0 }) },
      rateLimiter: { check: () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
      maxBodySize: "1kb",
    } as unknown as GatewayDeps;

    const app = express();
    app.use(requestIdMiddleware);
    app.use("/gateway", createGatewayRouter(deps));
    app.use(errorHandler);

    // 50 bytes — well within the 1kb limit
    const smallBody = { data: "x".repeat(50) };

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      .set("x-api-key", apiKey)
      .send(smallBody);

    // Body parsed successfully; billing refused (402) — not a body-size rejection
    expect(res.status).toBe(402);
    expect(res.status).not.toBe(413);
  });

  test("returns 413 when POST body exceeds the configured size limit", async () => {
    const { app, apiKey, apiId } = buildApp("100b");
    // 300 bytes — over the 100-byte test limit
    const largeBody = { data: "x".repeat(300) };

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      .set("x-api-key", apiKey)
      .send(largeBody);

    expect(res.status).toBe(413);
  });

  test("returns 413 without requiring a valid API key when body exceeds the limit", async () => {
    // Body parsing runs before auth; a 413 must be returned even with a missing key
    const { app, apiId } = buildApp("100b");
    const largeBody = { data: "x".repeat(300) };

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      // no x-api-key header
      .send(largeBody);

    expect(res.status).toBe(413);
  });

  test("defaults to 1mb limit when maxBodySize is not specified", async () => {
    const apiKey = "test-key";
    const apiId = "my-api";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });

    const deps = {
      // Fail billing fast so we never attempt the upstream fetch
      billing: { deductCredit: async () => ({ success: false, balance: 0 }) },
      rateLimiter: { check: () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
      // no maxBodySize → defaults to 1mb
    } as unknown as GatewayDeps;

    const app = express();
    app.use(requestIdMiddleware);
    app.use("/gateway", createGatewayRouter(deps));
    app.use(errorHandler);

    // 500 KB — under the 1mb default limit
    const body = { data: "x".repeat(500 * 1024) };

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      .set("x-api-key", apiKey)
      .send(body);

    expect(res.status).not.toBe(413);
  });

  test("rejects GET requests not affected — limit only applies to bodies", async () => {
    // GET requests have no body; ensure they are unaffected by the size limit
    const { app, apiKey, apiId } = buildApp("1b"); // absurdly small limit

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set("x-api-key", apiKey);

    expect(res.status).not.toBe(413);
  });

  test("returns 413 error response with JSON content-type when error handler is present", async () => {
    const { app, apiKey, apiId } = buildApp("100b");
    const largeBody = { data: "x".repeat(300) };

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      .set("x-api-key", apiKey)
      .send(largeBody);

    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveProperty("code", "REQUEST_BODY_TOO_LARGE");
    expect(res.body).toHaveProperty("message", "Request body too large");
  });
});

describe("gateway route - request id propagation", () => {
  test("reuses the edge request id for upstream calls and response headers", async () => {
    const apiKey = "test-key";
    const apiId = "my-api";
    const edgeRequestId = "edge-request-123";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const usageStore = { record: jest.fn() };
      const deps = {
        billing: { deductCredit: async () => ({ success: true, balance: 100 }) },
        rateLimiter: { check: async () => ({ allowed: true }) },
        usageStore,
        upstreamUrl: "http://example.internal",
        apiKeys,
      } as unknown as GatewayDeps;

      const app = express();
      app.use(requestIdMiddleware);
      app.use("/gateway", createGatewayRouter(deps));
      app.use(errorHandler);

      const res = await request(app)
        .post(`/gateway/${apiId}`)
        .set("x-api-key", apiKey)
        .set("x-request-id", edgeRequestId)
        .send({ hello: "world" });

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBe(edgeRequestId);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["x-request-id"]).toBe(edgeRequestId);
      expect(usageStore.record).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: edgeRequestId }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Bug #421 — prefix-exists-but-hash-mismatch must return 401, not 500
// ---------------------------------------------------------------------------
describe("gateway route - API key prefix / hash mismatch (bug #421)", () => {
  /**
   * Build a minimal app wired to a controlled apiKeys Map.
   * Billing is set to fail fast (402) so we never attempt a real upstream
   * request — we only care about the auth layer here.
   */
  function buildApp(apiKeys: Map<string, ApiKey>) {
    const deps = {
      billing: { deductCredit: async () => ({ success: false, balance: 0 }) },
      rateLimiter: { check: async () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
    } as unknown as GatewayDeps;

    const app = express();
    app.use(requestIdMiddleware);
    app.use("/gateway", createGatewayRouter(deps));
    app.use(errorHandler);
    return app;
  }

  const API_ID = "my-api";

  /**
   * Construct a key whose first 16 characters (the prefix) are identical to
   * `validKey` but whose remaining characters differ — prefix matches but the
   * SHA-256 hash of the full key will not match.
   */
  function buildMismatchedKey(validKey: string): string {
    // Keep the same 16-char prefix, replace the rest so the hash diverges.
    const prefix = validKey.slice(0, 16);
    const differentSuffix = "X".repeat(validKey.length - 16);
    return prefix + differentSuffix;
  }

  test("returns 401 (not 500) when prefix matches but hash mismatches", async () => {
    const validKey = "test-key-abcdefgh"; // 17 chars; prefix = "test-key-abcdefg"
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(validKey, { key: "k1", apiId: API_ID, developerId: "dev1" });

    const app = buildApp(apiKeys);
    const mismatchedKey = buildMismatchedKey(validKey);

    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", mismatchedKey);

    // Must be 401, never 500.
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("code", "UNAUTHORIZED");
    // Generic message — must not reveal whether the prefix was found.
    expect(res.body.message).toMatch(/invalid API key/i);
  });

  test("returns 401 when prefix does not exist at all (no-prefix path)", async () => {
    const validKey = "test-key-abcdefgh";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(validKey, { key: "k1", apiId: API_ID, developerId: "dev1" });

    const app = buildApp(apiKeys);

    // Completely different prefix — no candidate will be found.
    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", "totally-unknown-key-xyz");

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("code", "UNAUTHORIZED");
    expect(res.body.message).toMatch(/invalid API key/i);
  });

  test("happy path — exact key match passes auth and reaches billing", async () => {
    const validKey = "test-key-abcdefgh";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(validKey, { key: "k1", apiId: API_ID, developerId: "dev1" });

    const app = buildApp(apiKeys);

    // Billing is stubbed to fail (402) so we know auth succeeded.
    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", validKey);

    expect(res.status).toBe(402);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(500);
  });

  test("returns 401 when the matching key belongs to a different apiId", async () => {
    const validKey = "test-key-abcdefgh";
    const apiKeys = new Map<string, ApiKey>();
    // Key is registered under "other-api", not "my-api".
    apiKeys.set(validKey, { key: "k1", apiId: "other-api", developerId: "dev1" });

    const app = buildApp(apiKeys);

    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", validKey);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("code", "UNAUTHORIZED");
  });

  test("returns 403 when key is revoked (prefix + hash match a revoked key)", async () => {
    const validKey = "test-key-abcdefgh";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(validKey, {
      key: "k1",
      apiId: API_ID,
      developerId: "dev1",
      revoked: true,
    });

    const app = buildApp(apiKeys);

    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", validKey);

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("code", "FORBIDDEN");
  });

  test("returns 403 when key is in revocation list", async () => {
    const validKey = "test-key-abcdefgh";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(validKey, {
      key: "k1",
      apiId: API_ID,
      developerId: "dev1",
      revoked: false,
    });

    const { resetTokenRevocationService, getTokenRevocationService } = await import("../services/tokenRevocation.js");
    resetTokenRevocationService();
    const tokenRevocation = getTokenRevocationService({ defaultTtlMs: 60000 });
    
    const { createHash } = await import("node:crypto");
    const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
    tokenRevocation.revoke(sha256Hex(validKey));

    try {
      const app = buildApp(apiKeys);

      const res = await request(app)
        .get(`/gateway/${API_ID}`)
        .set("x-api-key", validKey);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("code", "FORBIDDEN");
    } finally {
      resetTokenRevocationService();
    }
  });

  test("401 response body is identical for both mismatch and no-prefix cases (no timing oracle via body)", async () => {
    const validKey = "test-key-abcdefgh";
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(validKey, { key: "k1", apiId: API_ID, developerId: "dev1" });

    const app = buildApp(apiKeys);

    const [mismatchRes, unknownRes] = await Promise.all([
      request(app)
        .get(`/gateway/${API_ID}`)
        .set("x-api-key", buildMismatchedKey(validKey)),
      request(app)
        .get(`/gateway/${API_ID}`)
        .set("x-api-key", "totally-unknown-key-xyz"),
    ]);

    // Status codes must be identical.
    expect(mismatchRes.status).toBe(401);
    expect(unknownRes.status).toBe(401);

    // Response codes must be identical — client must not be able to distinguish.
    expect(mismatchRes.body.code).toBe(unknownRes.body.code);
    expect(mismatchRes.body.message).toBe(unknownRes.body.message);
  });
});

// ---------------------------------------------------------------------------
// X-Correlation-Id generation and propagation (GrantFox FWC26)
// ---------------------------------------------------------------------------

describe('gateway route - X-Correlation-Id propagation', () => {
  /**
   * Build a minimal app with a fetch mock that records outbound request headers.
   * Billing can be set to succeed (to hit the upstream fetch) or fail (to stop
   * before the fetch — useful for non-upstream tests).
   */
  function buildCorrelationApp(
    options: {
      billingSuccess?: boolean;
      fetchMock?: jest.Mock;
    } = {},
  ) {
    const apiKey = 'corr-test-key-x';
    const apiId = 'my-api';
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: 'k1', apiId, developerId: 'dev1' });

    const fetchMock =
      options.fetchMock ??
      jest.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ ok: true }),
      } as Response);

    const billingSuccess = options.billingSuccess ?? true;

    const deps = {
      billing: {
        deductCredit: async () =>
          billingSuccess
            ? { success: true, balance: 100 }
            : { success: false, balance: 0 },
      },
      rateLimiter: { check: async () => ({ allowed: true }) },
      usageStore: { record: jest.fn().mockResolvedValue(true) },
      upstreamUrl: 'http://example.internal',
      apiKeys,
    } as unknown as GatewayDeps;

    const app = express();
    app.use(requestIdMiddleware);
    app.use('/gateway', createGatewayRouter(deps));
    app.use(errorHandler);

    return { app, apiKey, apiId, fetchMock };
  }

  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // ── Response header presence ──────────────────────────────────────────────

  test('response always contains X-Correlation-Id header', async () => {
    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: false });

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey);

    // Even when billing fails (402), the correlation header must be set
    expect(res.status).toBe(402);
    expect(res.headers).toHaveProperty('x-correlation-id');
    expect(typeof res.headers['x-correlation-id']).toBe('string');
    expect(res.headers['x-correlation-id'].length).toBeGreaterThan(0);
  });

  test('echoes client-supplied X-Correlation-Id in response header', async () => {
    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: false });
    const clientCorrelationId = 'client-corr-fwc26-001';

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-correlation-id', clientCorrelationId);

    expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
  });

  test('falls back to X-Request-Id when no X-Correlation-Id header is provided', async () => {
    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: false });
    const edgeRequestId = 'edge-req-fallback-42';

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-request-id', edgeRequestId);

    // No x-correlation-id supplied — should fall back to the request-id
    expect(res.headers['x-correlation-id']).toBe(edgeRequestId);
  });

  test('generates a UUID correlation-id when neither header is provided', async () => {
    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: false });

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey);
    // Don't set any x-correlation-id or x-request-id

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(res.headers['x-correlation-id']).toMatch(uuidRegex);
  });

  // ── Outbound propagation ──────────────────────────────────────────────────

  test('forwards x-correlation-id to upstream service when billing succeeds', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ proxied: true }),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: true, fetchMock });
    const clientCorrelationId = 'client-corr-outbound-99';

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-correlation-id', clientCorrelationId)
      .send({ data: 'test' });

    expect(res.status).toBe(200);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders['x-correlation-id']).toBe(clientCorrelationId);
  });

  test('forwards x-request-id AND x-correlation-id independently to upstream', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: true, fetchMock });
    const edgeRequestId = 'edge-req-id-123';
    const clientCorrelationId = 'client-corr-456';

    await request(app)
      .post(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-request-id', edgeRequestId)
      .set('x-correlation-id', clientCorrelationId)
      .send({ hello: 'world' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders['x-request-id']).toBe(edgeRequestId);
    expect(sentHeaders['x-correlation-id']).toBe(clientCorrelationId);
  });

  test('uses request-id as correlation-id fallback in outbound headers', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: true, fetchMock });
    const edgeRequestId = 'edge-req-fallback-corr-789';

    await request(app)
      .post(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-request-id', edgeRequestId)
      // no x-correlation-id — should fall back to x-request-id
      .send({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders['x-correlation-id']).toBe(edgeRequestId);
  });

  // ── Sanitisation ──────────────────────────────────────────────────────────

  test('strips oversized correlation-id and falls back to request-id', async () => {
    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: false });
    const oversized = 'x'.repeat(129); // exceeds 128-char limit
    const edgeRequestId = 'safe-fallback-req-id';

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-correlation-id', oversized)
      .set('x-request-id', edgeRequestId);

    // Oversized header discarded; falls back to request-id
    expect(res.headers['x-correlation-id']).toBe(edgeRequestId);
  });

  test('strips control characters from incoming x-correlation-id', async () => {
    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: false });
    // CR/LF stripped — result is "injected-corrX-Evil: foo" → well within max length
    const raw = 'injected-corr\r\nX-Evil: foo';

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-correlation-id', raw);

    // The sanitised value should NOT contain control characters
    expect(res.headers['x-correlation-id']).not.toMatch(/[\r\n]/);
  });

  // ── Response consistency ──────────────────────────────────────────────────

  test('X-Correlation-Id is consistent across request and response headers', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { app, apiKey, apiId } = buildCorrelationApp({ billingSuccess: true, fetchMock });
    const clientCorrelationId = 'consistent-corr-abc';

    const res = await request(app)
      .post(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-correlation-id', clientCorrelationId)
      .send({});

    expect(res.status).toBe(200);

    // Response header echoes the client value
    expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);

    // Outbound header also carries the same value
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders['x-correlation-id']).toBe(clientCorrelationId);
  });

  // ── Edge-auth short-circuits ──────────────────────────────────────────────

  test('X-Correlation-Id is set even when request is rejected at auth (missing key)', async () => {
    const { app, apiId } = buildCorrelationApp();
    const clientCorrelationId = 'corr-no-key-scenario';

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      // no x-api-key
      .set('x-correlation-id', clientCorrelationId);

    expect(res.status).toBe(401);
    expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
  });

  test('X-Correlation-Id is set even when rate limited (429)', async () => {
    const apiKey = 'corr-rate-limit-key';
    const apiId = 'my-api';
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(apiKey, { key: 'k1', apiId, developerId: 'dev1' });

    const windowMs = 60_000;
    const { createRateLimiter } = await import('../services/rateLimiter.js');
    const rateLimiter = createRateLimiter(1, windowMs);
    rateLimiter.exhaust(apiKey);

    const deps = {
      billing: { deductCredit: async () => ({ success: true, balance: 100 }) },
      rateLimiter,
      usageStore: { record: jest.fn() },
      upstreamUrl: 'http://example.invalid',
      apiKeys,
    } as unknown as GatewayDeps;

    const app = express();
    app.use(requestIdMiddleware);
    app.use('/gateway', createGatewayRouter(deps));
    app.use(errorHandler);

    const clientCorrelationId = 'corr-rate-limited-scenario';

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set('x-api-key', apiKey)
      .set('x-correlation-id', clientCorrelationId);

    expect(res.status).toBe(429);
    expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
  });
});
