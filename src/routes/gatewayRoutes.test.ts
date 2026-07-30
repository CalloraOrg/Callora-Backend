import express from "express";
import request from "supertest";
import { createGatewayRouter } from "./gatewayRoutes.js";
import { createRateLimiter } from "../services/rateLimiter.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import type { ApiKey } from "../types/gateway.js";

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
    const apiKeys = new Map<string, any>();
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
    } as any;

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
    const apiKeys = new Map<string, any>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });

    const deps = {
      billing: { deductCredit: async () => ({ success: true, balance: 100 }) },
      rateLimiter: { check: () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
      maxBodySize,
    } as any;

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
    const apiKeys = new Map<string, any>();
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
    } as any;

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
    const apiKeys = new Map<string, any>();
    apiKeys.set(apiKey, { key: "k1", apiId, developerId: "dev1" });

    const deps = {
      // Fail billing fast so we never attempt the upstream fetch
      billing: { deductCredit: async () => ({ success: false, balance: 0 }) },
      rateLimiter: { check: () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
      // no maxBodySize → defaults to 1mb
    } as any;

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
    } as any;

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
// gatewayRoutes.ts — per-user token-bucket inline invocation (issue #870)
//
// These tests exercise the inline gatewayRateLimit(req, res, () => {...})
// call path inside the router.all('/:apiId', ...) handler in gatewayRoutes.ts.
// They use createGatewayRouter directly with a gatewayRateLimitMiddleware stub
// injected via GatewayDeps so the new code paths show up in coverage for that
// file, not just gatewayRateLimit.ts.
// ---------------------------------------------------------------------------
describe("gateway route - per-user token-bucket rate limit (issue #870)", () => {
  const API_ID = "my-api";
  const VALID_KEY = "test-key-abcdefgh";

  function buildGatewayApp(
    gatewayRateLimitMiddleware: import("express").RequestHandler,
    extra?: Partial<import("../types/gateway.js").GatewayDeps>,
  ) {
    const apiKeys = new Map<string, ApiKey>();
    apiKeys.set(VALID_KEY, { key: "k1", apiId: API_ID, developerId: "dev1" });

    const deps = {
      billing: { deductCredit: async () => ({ success: false, balance: 0 }) }, // 402 fast
      rateLimiter: { check: async () => ({ allowed: true }) },
      usageStore: { record: () => true },
      upstreamUrl: "http://example.invalid",
      apiKeys,
      gatewayRateLimitMiddleware,
      ...extra,
    } as any;

    const app = express();
    app.use(requestIdMiddleware);
    app.use("/gateway", createGatewayRouter(deps));
    app.use(errorHandler);
    return app;
  }

  test("passes through to downstream handler when rate limiter calls next()", async () => {
    // Middleware that always calls next() — exercises the gatewayRateLimitPassed=true path
    const passThroughMiddleware: import("express").RequestHandler = (_req, _res, next) => {
      next();
    };

    const app = buildGatewayApp(passThroughMiddleware);
    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", VALID_KEY);

    // Billing stub returns 402 — proves the inline check passed and execution continued
    expect(res.status).toBe(402);
  });

  test("returns 429 and stops processing when rate limiter writes its own response (gatewayRateLimitPassed=false path)", async () => {
    // Middleware that writes a 429 itself and does NOT call next() —
    // exercises the gatewayRateLimitPassed=false early-return path in gatewayRoutes.ts
    const blockingMiddleware: import("express").RequestHandler = (_req, res, _next) => {
      res.status(429).json({
        code: "TOO_MANY_REQUESTS",
        message: "Too Many Requests",
        requestId: "test-req-id",
        retryAfterMs: 30_000,
      });
    };

    const app = buildGatewayApp(blockingMiddleware);
    const res = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", VALID_KEY);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
    // Billing must NOT have been called — the handler returned before reaching it
    // (confirmed by absence of a 402 status)
    expect(res.status).not.toBe(402);
  });

  test("rate limiter receives req.apiKeyRecord.userId = keyRecord.developerId", async () => {
    // Verify that the inline req.apiKeyRecord assignment writes the correct userId
    // so that the token-bucket key matches the developer, not the raw API key string.
    let capturedUserId: string | undefined;

    const inspectingMiddleware: import("express").RequestHandler = (req, _res, next) => {
      const record = req.apiKeyRecord as { userId?: string } | undefined;
      capturedUserId = record?.userId;
      next();
    };

    const app = buildGatewayApp(inspectingMiddleware);
    await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", VALID_KEY);

    expect(capturedUserId).toBe("dev1"); // keyRecord.developerId from apiKeys map
  });

  test("returns 429 with Retry-After header via real InMemoryGatewayRateLimiter through createGatewayRouter", async () => {
    // Wire a real (not stubbed) token-bucket limiter with limit=1 into the gateway router
    // to exercise the full path: auth → req.apiKeyRecord assignment → limiter.check() →
    // 429 written by middleware → gatewayRateLimitPassed=false → early return.
    const { createGatewayRateLimitMiddleware, InMemoryGatewayRateLimiter } = await import(
      "../middleware/gatewayRateLimit.js"
    );

    const limiter = new InMemoryGatewayRateLimiter(60_000, 1);
    const rl = createGatewayRateLimitMiddleware({ windowMs: 60_000, maxRequests: 1 }, limiter);

    const app = buildGatewayApp(rl);

    // First request — token bucket not yet exhausted, billing stub returns 402
    const first = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", VALID_KEY);
    expect(first.status).toBe(402); // auth + rate limit passed, billing fails fast

    // Second request — bucket empty, rate limiter writes 429 directly
    const second = await request(app)
      .get(`/gateway/${API_ID}`)
      .set("x-api-key", VALID_KEY);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("TOO_MANY_REQUESTS");
    expect(second.headers["retry-after"]).toBeDefined();
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    expect(second.body.retryAfterMs).toBeGreaterThan(0);
  });
});
