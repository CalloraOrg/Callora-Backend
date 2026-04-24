import express from "express";
import request from "supertest";
import { createGatewayRouter } from "./gatewayRoutes.js";
import { createRateLimiter } from "../services/rateLimiter.js";
import { errorHandler } from "../middleware/errorHandler.js";

describe("gateway route - rate limiting", () => {
  beforeEach(() => {
    jest.useFakeTimers("modern" as unknown as any);
    jest.setSystemTime(new Date("2026-03-30T00:00:00.000Z").getTime());
  });

  afterEach(() => {
    jest.useRealTimers();
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
    app.use("/gateway", createGatewayRouter(deps));

    const res = await request(app)
      .get(`/gateway/${apiId}`)
      .set("x-api-key", apiKey);

    expect(res.status).toBe(429);
    // Retry-After header is in seconds, rounded up
    expect(res.headers["retry-after"]).toBe(String(Math.ceil(windowMs / 1000)));
    expect(res.body).toHaveProperty("error", "Too Many Requests");
    expect(res.body).toHaveProperty("retryAfterMs", windowMs);
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
    expect(res.body).toHaveProperty("error", "Request body too large");
  });
});
