import express from "express";
import request from "supertest";
import { errorHandler } from "./errorHandler.js";
import {
  createRateLimitMiddleware,
  TokenBucketRateLimiter,
  createTokenBucketRateLimitMiddleware,
  InMemoryRateLimiter, // <-- Added missing import
} from "./rateLimit.js";
import { requireAuth, type AuthenticatedLocals } from "./requireAuth.js";
import { TEST_JWT_SECRET, signTestToken } from "../../tests/helpers/jwt.js";
import { logger } from "../logger.js";

function buildProtectedApp(windowMs = 60_000, maxRequests = 2) {
  const app = express();
  const rateLimit = createRateLimitMiddleware({
    windowMs,
    maxRequests,
  });

  app.get(
    "/protected",
    rateLimit,
    requireAuth,
    (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
      res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
    },
  );

  app.use(errorHandler);
  return app;
}

describe("rateLimit middleware (token-bucket)", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    // Silence expected rate limit warning/error console output during tests
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

  it("returns 429 after the per-user limit is exceeded with canonical error envelope", async () => {
    const app = buildProtectedApp();

    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    const response = await request(app)
      .get("/protected")
      .set("x-user-id", "user-1");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(response.body.error.message).toBe("Too Many Requests");
    expect(response.body.error.details.retryAfterMs).toBeGreaterThan(0);
    expect(response.body.requestId).toBeDefined();
    expect(response.body.timestamp).toBeDefined();
  });

  it("tracks requests separately for different users", async () => {
    const app = buildProtectedApp();

    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-2").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-2").expect(200);

    await request(app).get("/protected").set("x-user-id", "user-1").expect(429);
    await request(app).get("/protected").set("x-user-id", "user-2").expect(429);
  });

  it("uses the authenticated user id when a bearer token is present", async () => {
    const app = buildProtectedApp();
    const token = signTestToken({
      userId: "user-1",
      walletAddress: "GDTEST123STELLAR",
    });

    await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);

    const response = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
  });

  it("refills tokens after window elapses", async () => {
    const windowMs = 100;
    const limiter = new InMemoryRateLimiter(windowMs, 2);

    limiter.check("key", 0);
    limiter.check("key", 0);
    const blocked = limiter.check("key", 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(windowMs);

    const afterWindow = limiter.check("key", windowMs + 1);
    expect(afterWindow.allowed).toBe(true);
  });

  it("returns 429 with Retry-After header and structured details", async () => {
    const app = buildProtectedApp(1000, 1);

    await request(app).get("/protected").set("x-user-id", "user-x").expect(200);
    const response = await request(app)
      .get("/protected")
      .set("x-user-id", "user-x");

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(typeof response.body.error.details.retryAfterMs).toBe("number");
    expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("falls back to IP-based keying when no user id is provided", async () => {
    const app = express();
    const rateLimit = createRateLimitMiddleware({
      windowMs: 60_000,
      maxRequests: 1,
    });
    app.get("/public", rateLimit, (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    await request(app).get("/public").expect(200);
    const response = await request(app).get("/public");

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("TokenBucketRateLimiter", () => {
  let now: number;

  beforeEach(() => {
    now = 100_000;
  });

  test("allows requests up to capacity", () => {
    const limiter = new TokenBucketRateLimiter(3, 1);
    expect(limiter.check("key", now)).toEqual({ allowed: true });
    expect(limiter.check("key", now)).toEqual({ allowed: true });
    expect(limiter.check("key", now)).toEqual({ allowed: true });
  });

  test("denies when tokens are exhausted", () => {
    const limiter = new TokenBucketRateLimiter(2, 1);
    limiter.check("key", now);
    limiter.check("key", now);
    const result = limiter.check("key", now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("refills tokens over time", () => {
    const limiter = new TokenBucketRateLimiter(2, 1);
    limiter.check("key", now);
    limiter.check("key", now);
    expect(limiter.check("key", now).allowed).toBe(false);

    const result = limiter.check("key", now + 2000);
    expect(result.allowed).toBe(true);
  });

  test("tracks buckets separately per key", () => {
    const limiter = new TokenBucketRateLimiter(1, 1);
    expect(limiter.check("user-a", now)).toEqual({ allowed: true });
    expect(limiter.check("user-b", now)).toEqual({ allowed: true });
    expect(limiter.check("user-a", now)).toEqual({
      allowed: false,
      retryAfterMs: 1000,
    });
    expect(limiter.check("user-b", now)).toEqual({
      allowed: false,
      retryAfterMs: 1000,
    });
  });

  test("does not exceed capacity on refill", () => {
    const limiter = new TokenBucketRateLimiter(3, 5);
    limiter.check("key", now);
    const result = limiter.check("key", now + 10_000);
    expect(result.allowed).toBe(true);
    expect(limiter.check("key", now + 10_000).allowed).toBe(true);
    expect(limiter.check("key", now + 10_000).allowed).toBe(true);
    expect(limiter.check("key", now + 10_000).allowed).toBe(false);
  });

  test("retryAfterMs is proportional to refill rate", () => {
    const limiter = new TokenBucketRateLimiter(1, 2);
    limiter.check("key", now);
    const result = limiter.check("key", now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(500);
  });

  test("reset clears all buckets", () => {
    const limiter = new TokenBucketRateLimiter(1, 1);
    limiter.check("key-a", now);
    limiter.check("key-b", now);
    limiter.reset();
    expect(limiter.check("key-a", now)).toEqual({ allowed: true });
    expect(limiter.check("key-b", now)).toEqual({ allowed: true });
  });

  test("partial refill accumulates fractional tokens across multiple checks", () => {
    const limiter = new TokenBucketRateLimiter(1, 0.5);
    limiter.check("key", now);
    expect(limiter.check("key", now + 1000).allowed).toBe(false);
    expect(limiter.check("key", now + 2000).allowed).toBe(true);
    expect(limiter.check("key", now + 2000).allowed).toBe(false);
  });
});

describe("token bucket rate limit middleware", () => {
  const originalSecret = process.env.JWT_SECRET;

  function buildTokenBucketApp(capacity = 3, refillRate = 1) {
    const app = express();
    const rateLimit = createTokenBucketRateLimitMiddleware({
      capacity,
      refillRate,
    });

    app.get(
      "/protected",
      rateLimit,
      requireAuth,
      (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
        res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
      },
    );

    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
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

  test("returns 200 within burst capacity", async () => {
    const app = buildTokenBucketApp(3, 1);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
  });

  test("returns 429 after burst capacity is exceeded", async () => {
    const app = buildTokenBucketApp(2, 1);

    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    const response = await request(app)
      .get("/protected")
      .set("x-user-id", "user-1");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    const retryAfterMs =
      response.body.retryAfterMs ?? response.body.error?.details?.retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
  });

  test("tracks limits separately per user", async () => {
    const app = buildTokenBucketApp(2, 1);

    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-2").expect(200);

    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    await request(app).get("/protected").set("x-user-id", "user-2").expect(200);

    await request(app).get("/protected").set("x-user-id", "user-1").expect(429);
    await request(app).get("/protected").set("x-user-id", "user-2").expect(429);
  });

  test("returns 429 with code TOO_MANY_REQUESTS", async () => {
    const app = buildTokenBucketApp(1, 1);

    await request(app).get("/protected").set("x-user-id", "user-1").expect(200);
    const response = await request(app)
      .get("/protected")
      .set("x-user-id", "user-1");

    expect(response.status).toBe(429);
    const code = response.body.code ?? response.body.error?.code;
    const message = response.body.message ?? response.body.error?.message;
    expect(code).toBe("TOO_MANY_REQUESTS");
    expect(message).toBe("Too Many Requests");
  });
});
