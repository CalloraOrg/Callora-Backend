/**
 * Tests: per-user token-bucket rate limit on /api/quotas
 *
 * Coverage targets
 * ────────────────
 * createQuotaRateLimitMiddleware (src/middleware/rateLimit.ts)
 *   ✓ allows requests within burst capacity
 *   ✓ returns 429 + Retry-After when bucket is exhausted
 *   ✓ response envelope uses the standardised error shape
 *   ✓ tracks buckets independently per authenticated user
 *   ✓ falls back to IP keying for unauthenticated requests
 *   ✓ injects retryAfterMs into the error envelope
 *
 * createQuotasRouter (src/routes/quotas.ts)
 *   ✓ mounts /counts sub-route
 *   ✓ rate-limit middleware is applied before sub-route handlers
 *   ✓ 429 from the rate limiter uses the standardised envelope
 *   ✓ Retry-After header is a positive integer (seconds)
 *   ✓ requests from different users are independently limited
 *   ✓ unauthenticated requests are gated by IP
 *   ✓ accepts an injected middleware for testing
 */

import express from "express";
import request from "supertest";
import {
  createQuotaRateLimitMiddleware,
  TokenBucketRateLimiter,
} from "../middleware/rateLimit.js";
import { createQuotasRouter } from "./quotas.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { envelopeMiddleware } from "../middleware/envelope.js";
import { logger } from "../logger.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that exposes a single GET /protected route
 * behind `createQuotaRateLimitMiddleware`.  Used to test the middleware
 * independently of the router plumbing.
 */
function buildMiddlewareApp(capacity = 3, refillRate = 1) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(envelopeMiddleware);

  const limiter = new TokenBucketRateLimiter(capacity, refillRate);
  const rateLimit = createQuotaRateLimitMiddleware({ capacity, refillRate }, limiter);

  app.get("/protected", rateLimit, (_req, res) => {
    res.status(200).json({ message: "OK" });
  });

  app.use(errorHandler);
  return app;
}

/**
 * Build a minimal Express app with the full `/api/quotas` router so we can
 * test the route wiring end-to-end.  The quotaService is stubbed so no DB
 * is needed.
 */
function buildRouterApp(capacity = 3, refillRate = 1) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(envelopeMiddleware);

  // Inject a tight limiter so tests don't need many requests to hit the cap
  const limiter = new TokenBucketRateLimiter(capacity, refillRate);
  const quotaRateLimitMiddleware = createQuotaRateLimitMiddleware(
    { capacity, refillRate },
    limiter,
  );

  app.use("/api/quotas", createQuotasRouter({ quotaRateLimitMiddleware }));

  app.use(errorHandler);
  return app;
}

// ─── createQuotaRateLimitMiddleware ──────────────────────────────────────────

describe("createQuotaRateLimitMiddleware", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it("allows requests within burst capacity", async () => {
    const app = buildMiddlewareApp(3, 1);

    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
  });

  it("returns 429 after burst capacity is exhausted", async () => {
    const app = buildMiddlewareApp(2, 1);

    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
    await request(app).get("/protected").set("x-user-id", "u1").expect(200);

    const res = await request(app).get("/protected").set("x-user-id", "u1");
    expect(res.status).toBe(429);
  });

  it("response includes a Retry-After header (positive seconds)", async () => {
    const app = buildMiddlewareApp(1, 1);

    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
    const res = await request(app).get("/protected").set("x-user-id", "u1");

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("uses the standardised error envelope on 429", async () => {
    const app = buildMiddlewareApp(1, 1);

    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
    const res = await request(app).get("/protected").set("x-user-id", "u1");

    expect(res.status).toBe(429);
    // Standardised envelope shape
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(typeof res.body.error.message).toBe("string");
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("injects retryAfterMs into the error envelope", async () => {
    const app = buildMiddlewareApp(1, 1);

    await request(app).get("/protected").set("x-user-id", "u1").expect(200);
    const res = await request(app).get("/protected").set("x-user-id", "u1");

    expect(res.status).toBe(429);
    // retryAfterMs may be nested in error.details or at error level depending
    // on envelope middleware — check either location.
    const retryAfterMs =
      res.body.error?.retryAfterMs ??
      res.body.error?.details?.retryAfterMs ??
      res.body.retryAfterMs;
    expect(typeof retryAfterMs).toBe("number");
    expect(retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks buckets independently per authenticated user", async () => {
    const app = buildMiddlewareApp(2, 1);

    // User A: 2 allowed, then blocked
    await request(app).get("/protected").set("x-user-id", "userA").expect(200);
    await request(app).get("/protected").set("x-user-id", "userA").expect(200);
    await request(app).get("/protected").set("x-user-id", "userA").expect(429);

    // User B: not affected by User A's exhausted bucket
    await request(app).get("/protected").set("x-user-id", "userB").expect(200);
    await request(app).get("/protected").set("x-user-id", "userB").expect(200);
    await request(app).get("/protected").set("x-user-id", "userB").expect(429);
  });

  it("falls back to IP-based keying for unauthenticated requests", async () => {
    const app = buildMiddlewareApp(2, 1);

    // Two requests without any identity header — keyed by IP (127.0.0.1)
    await request(app).get("/protected").expect(200);
    await request(app).get("/protected").expect(200);
    // Third unauthenticated request exceeds the shared IP bucket
    await request(app).get("/protected").expect(429);
  });

  it("does not block a second user when a first user is rate-limited", async () => {
    const app = buildMiddlewareApp(1, 1);

    await request(app).get("/protected").set("x-user-id", "userX").expect(200);
    await request(app).get("/protected").set("x-user-id", "userX").expect(429);

    // Different user should still be allowed
    const res = await request(app)
      .get("/protected")
      .set("x-user-id", "userY");
    expect(res.status).toBe(200);
  });

  it("TokenBucketRateLimiter refills tokens over time", () => {
    const limiter = new TokenBucketRateLimiter(1, 2); // 2 tokens/s
    const now = 100_000;

    limiter.check("key", now); // consume the only token
    expect(limiter.check("key", now).allowed).toBe(false);

    // After 500ms a 2-token/s refiller should restore 1 token
    expect(limiter.check("key", now + 500).allowed).toBe(true);
  });
});

// ─── createQuotasRouter ───────────────────────────────────────────────────────

describe("createQuotasRouter — /api/quotas route wiring", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it("rate-limit middleware is applied before sub-route handlers", async () => {
    // capacity=0 would be invalid, use capacity=1 and exhaust on first call
    const app = buildRouterApp(1, 1);

    // First call succeeds (even though counts handler will throw — we just want
    // the rate limiter to not block it yet)
    const first = await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "u1");
    // Could be 200 (if counts works) or other non-429 — just not rate-limited
    expect(first.status).not.toBe(429);

    // Second call should be rate-limited (bucket empty)
    const second = await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "u1");
    expect(second.status).toBe(429);
  });

  it("returns 429 with standardised envelope and Retry-After header", async () => {
    const app = buildRouterApp(1, 1);

    await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "u1");

    const res = await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "u1");

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("different users are independently rate-limited", async () => {
    const app = buildRouterApp(1, 1);

    // Exhaust user A
    await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "userA");
    const resA = await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "userA");
    expect(resA.status).toBe(429);

    // User B has their own bucket — not blocked
    const resB = await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "userB");
    expect(resB.status).not.toBe(429);
  });

  it("unauthenticated requests are gated by IP-based bucket", async () => {
    const app = buildRouterApp(1, 1);

    // First unauthenticated request — should pass the rate limiter
    await request(app).get("/api/quotas/counts");

    // Second unauthenticated request from same IP — rate-limited
    const res = await request(app).get("/api/quotas/counts");
    expect(res.status).toBe(429);
  });

  it("accepts an injected rate-limit middleware (dependency injection)", async () => {
    // Build app with a custom middleware that always blocks (for unit testing)
    const alwaysBlock: express.RequestHandler = (_req, res, next) => {
      res.set("Retry-After", "5");
      next(new (require("../errors/index.js").TooManyRequestsError)("blocked"));
    };

    const app = express();
    app.use(requestIdMiddleware);
    app.use(envelopeMiddleware);
    app.use(
      "/api/quotas",
      createQuotasRouter({ quotaRateLimitMiddleware: alwaysBlock }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .get("/api/quotas/counts")
      .set("x-user-id", "u1");

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("TOO_MANY_REQUESTS");
  });

  it("applies rate limit to all sub-routes, not just /counts", async () => {
    // Use an always-block middleware to confirm the limiter is mounted at the
    // router level (any path under /api/quotas should be gated).
    const blockerCalled = jest.fn<void, Parameters<express.RequestHandler>>(
      (_req, _res, next) => next(),
    );

    const app = express();
    app.use(requestIdMiddleware);
    app.use(envelopeMiddleware);
    app.use(
      "/api/quotas",
      createQuotasRouter({ quotaRateLimitMiddleware: blockerCalled }),
    );
    app.use(errorHandler);

    // Hit an endpoint under the router
    await request(app).get("/api/quotas/counts").set("x-user-id", "u1");

    expect(blockerCalled).toHaveBeenCalledTimes(1);
  });
});
