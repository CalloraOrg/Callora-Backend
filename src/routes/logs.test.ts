/**
 * Tests for src/routes/logs.ts
 *
 * Coverage targets:
 * - GET /api/logs  happy path, auth, rate limit
 * - POST /api/logs happy path, validation, auth, rate limit
 * - Per-user isolation (rate limit buckets AND log store)
 * - Retry-After header and response body shape on 429
 * - IP-based fallback when no user ID is present
 * - Log store is correctly filtered by userId on GET
 */

import express, { type Application } from "express";
import request from "supertest";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import {
  createLogsRouter,
  resetLogStore,
  logStore,
  type LogEntry,
} from "./logs.js";
import {
  TokenBucketRateLimiter,
  createTokenBucketRateLimitMiddleware,
} from "../middleware/rateLimit.js";
import { logger } from "../logger.js";
import { TEST_JWT_SECRET, signTestToken } from "../../tests/helpers/jwt.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an Express app that mounts /api/logs with an injected rate limiter.
 * Using a small-capacity limiter keeps tests deterministic without real timers.
 */
function buildApp(capacity = 10, refillRate = 1): Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/api/logs", createLogsRouter({ rateLimitOptions: { capacity, refillRate } }));
  app.use(errorHandler);
  return app;
}

/**
 * Build an app with a shared pre-built limiter instance — useful for
 * exhausting the bucket before issuing the assertion request.
 */
function buildAppWithLimiter(limiter: TokenBucketRateLimiter): Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/api/logs", createLogsRouter({ rateLimiter: limiter }));
  app.use(errorHandler);
  return app;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /api/logs", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    resetLogStore();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "info").mockImplementation(() => {});
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

  it("returns 200 with empty log list for a new user", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/logs")
      .set("x-user-id", "user-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.logs).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("returns 200 with the user's log entries", async () => {
    const app = buildApp();

    // Seed some entries
    logStore.push(
      {
        id: "1",
        userId: "user-1",
        level: "info",
        message: "hello",
        meta: {},
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "2",
        userId: "user-2",
        level: "warn",
        message: "other user",
        meta: {},
        createdAt: "2024-01-01T00:01:00.000Z",
      },
    );

    const res = await request(app)
      .get("/api/logs")
      .set("x-user-id", "user-1");

    expect(res.status).toBe(200);
    expect(res.body.data.logs).toHaveLength(1);
    expect(res.body.data.logs[0].userId).toBe("user-1");
    expect(res.body.data.logs[0].message).toBe("hello");
    expect(res.body.meta.total).toBe(1);
  });

  it("returns entries sorted newest-first", async () => {
    const app = buildApp();

    logStore.push(
      {
        id: "1",
        userId: "user-sort",
        level: "info",
        message: "older",
        meta: {},
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "2",
        userId: "user-sort",
        level: "info",
        message: "newer",
        meta: {},
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    );

    const res = await request(app)
      .get("/api/logs")
      .set("x-user-id", "user-sort");

    expect(res.status).toBe(200);
    expect(res.body.data.logs[0].message).toBe("newer");
    expect(res.body.data.logs[1].message).toBe("older");
  });

  it("returns 401 when no auth credentials are provided", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/logs");

    expect(res.status).toBe(401);
  });

  it("accepts a valid JWT bearer token", async () => {
    const app = buildApp();
    const token = signTestToken({ userId: "jwt-user-1", walletAddress: "GABCD" });

    const res = await request(app)
      .get("/api/logs")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 429 after the per-user token-bucket is exhausted", async () => {
    const app = buildApp(2, 1); // capacity = 2

    await request(app).get("/api/logs").set("x-user-id", "user-rl").expect(200);
    await request(app).get("/api/logs").set("x-user-id", "user-rl").expect(200);

    const res = await request(app)
      .get("/api/logs")
      .set("x-user-id", "user-rl");

    expect(res.status).toBe(429);
    // Retry-After header must be present and numeric
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    // Response body
    const code = res.body.code ?? res.body.error?.code;
    const retryAfterMs =
      res.body.retryAfterMs ?? res.body.error?.details?.retryAfterMs;
    expect(code).toBe("TOO_MANY_REQUESTS");
    expect(retryAfterMs).toBeGreaterThan(0);
  });

  it("rate-limit buckets are isolated per user on GET", async () => {
    const app = buildApp(1, 1); // capacity = 1 — one request per user

    // User 1 exhausts their bucket
    await request(app).get("/api/logs").set("x-user-id", "user-a").expect(200);
    await request(app).get("/api/logs").set("x-user-id", "user-a").expect(429);

    // User 2 still has a full bucket
    await request(app).get("/api/logs").set("x-user-id", "user-b").expect(200);
  });

  it("falls back to IP-based keying when no user is authenticated", async () => {
    // Build an app that doesn't require auth for GET, to test IP fallback.
    // We re-use buildApp but issue 2 requests from the same IP without a user ID.
    // NOTE: requireAuth will reject unauthenticated requests with 401 *after*
    // the rate limiter passes them through, so with capacity=1 we expect:
    //   - 1st request: rate limiter passes → requireAuth rejects with 401
    //   - 2nd request: rate limiter blocks with 429
    const app = buildApp(1, 1);

    const first = await request(app).get("/api/logs");
    expect(first.status).toBe(401); // passed rate limiter, rejected by requireAuth

    const second = await request(app).get("/api/logs");
    expect(second.status).toBe(429); // blocked by rate limiter
    expect(second.headers["retry-after"]).toBeDefined();
  });
});

describe("POST /api/logs", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    resetLogStore();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "info").mockImplementation(() => {});
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

  it("creates a log entry and returns 201", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-post-1")
      .send({ message: "hello world", level: "info", meta: { source: "test" } });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const entry: LogEntry = res.body.data;
    expect(entry.userId).toBe("user-post-1");
    expect(entry.message).toBe("hello world");
    expect(entry.level).toBe("info");
    expect(entry.meta).toEqual({ source: "test" });
    expect(entry.id).toBeDefined();
    expect(entry.createdAt).toBeDefined();
  });

  it("defaults level to 'info' when omitted", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-default")
      .send({ message: "default level" });

    expect(res.status).toBe(201);
    expect(res.body.data.level).toBe("info");
  });

  it("defaults meta to {} when omitted", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-meta")
      .send({ message: "no meta" });

    expect(res.status).toBe(201);
    expect(res.body.data.meta).toEqual({});
  });

  it("accepts all valid log levels", async () => {
    const app = buildApp();
    const levels = ["debug", "info", "warn", "error"] as const;

    for (const level of levels) {
      const res = await request(app)
        .post("/api/logs")
        .set("x-user-id", "user-levels")
        .send({ message: `a ${level} message`, level });

      expect(res.status).toBe(201);
      expect(res.body.data.level).toBe(level);
    }
  });

  it("persists the entry so GET returns it", async () => {
    const app = buildApp();

    await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-persist")
      .send({ message: "persisted entry", level: "warn" })
      .expect(201);

    const res = await request(app)
      .get("/api/logs")
      .set("x-user-id", "user-persist");

    expect(res.status).toBe(200);
    expect(res.body.data.logs).toHaveLength(1);
    expect(res.body.data.logs[0].message).toBe("persisted entry");
  });

  it("returns 400 when message is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-validation")
      .send({ level: "info" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when message is empty", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-validation-empty")
      .send({ message: "  ", level: "info" });

    // Zod trims the string before min(1) check, empty string fails
    expect(res.status).toBe(400);
  });

  it("returns 400 when level is invalid", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-bad-level")
      .send({ message: "hello", level: "trace" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when message exceeds 4096 chars", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-long")
      .send({ message: "x".repeat(4097) });

    expect(res.status).toBe(400);
  });

  it("returns 401 when no auth credentials are provided", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/logs")
      .send({ message: "no auth" });

    expect(res.status).toBe(401);
  });

  it("returns 429 after the per-user token-bucket is exhausted on POST", async () => {
    const app = buildApp(1, 1); // capacity = 1

    await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-rl-post")
      .send({ message: "first" })
      .expect(201);

    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "user-rl-post")
      .send({ message: "second" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    const retryAfterMs =
      res.body.retryAfterMs ?? res.body.error?.details?.retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
  });

  it("rate-limit buckets are isolated per user on POST", async () => {
    const app = buildApp(1, 1);

    await request(app)
      .post("/api/logs")
      .set("x-user-id", "post-a")
      .send({ message: "a" })
      .expect(201);

    // user-a is blocked
    await request(app)
      .post("/api/logs")
      .set("x-user-id", "post-a")
      .send({ message: "a2" })
      .expect(429);

    // user-b still has their own fresh bucket
    await request(app)
      .post("/api/logs")
      .set("x-user-id", "post-b")
      .send({ message: "b" })
      .expect(201);
  });

  it("shares bucket across GET and POST (same limiter instance)", async () => {
    const limiter = new TokenBucketRateLimiter(1, 1);
    const app = buildAppWithLimiter(limiter);

    // GET consumes the one token
    await request(app)
      .get("/api/logs")
      .set("x-user-id", "shared-user")
      .expect(200);

    // POST should now be rate-limited (same bucket)
    const res = await request(app)
      .post("/api/logs")
      .set("x-user-id", "shared-user")
      .send({ message: "should be blocked" });

    expect(res.status).toBe(429);
  });
});

describe("Rate-limit Retry-After semantics", () => {
  beforeEach(() => {
    resetLogStore();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("retryAfterMs in response body is positive when rate limited", async () => {
    const app = buildApp(1, 1);

    await request(app).get("/api/logs").set("x-user-id", "retry-user").expect(200);

    const res = await request(app).get("/api/logs").set("x-user-id", "retry-user");
    expect(res.status).toBe(429);
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
  });

  it("Retry-After header is at least 1 second", async () => {
    const app = buildApp(1, 1);

    await request(app).get("/api/logs").set("x-user-id", "retry-hdr").expect(200);

    const res = await request(app).get("/api/logs").set("x-user-id", "retry-hdr");
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("response body includes requestId", async () => {
    const app = buildApp(1, 1);

    await request(app).get("/api/logs").set("x-user-id", "retry-rid").expect(200);

    const res = await request(app).get("/api/logs").set("x-user-id", "retry-rid");
    expect(res.status).toBe(429);
    expect(res.body.requestId).toBeDefined();
  });

  it("rate-limit code is TOO_MANY_REQUESTS", async () => {
    const app = buildApp(1, 1);

    await request(app).get("/api/logs").set("x-user-id", "retry-code").expect(200);

    const res = await request(app).get("/api/logs").set("x-user-id", "retry-code");
    expect(res.status).toBe(429);
    const code = res.body.code ?? res.body.error?.code;
    expect(code).toBe("TOO_MANY_REQUESTS");
  });

  it("refills tokens after time elapses (unit-level bucket test)", () => {
    const limiter = new TokenBucketRateLimiter(1, 2); // 1 token, 2 tokens/s
    const now = 100_000;

    // Consume the single token
    expect(limiter.check("key", now).allowed).toBe(true);
    // Immediately exhausted
    expect(limiter.check("key", now).allowed).toBe(false);

    // After 500ms at 2 tokens/s, one token is available again
    expect(limiter.check("key", now + 500).allowed).toBe(true);
  });
});

describe("createLogsRouter factory", () => {
  beforeEach(() => {
    resetLogStore();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts a pre-built limiter instance", async () => {
    const limiter = new TokenBucketRateLimiter(5, 1);
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use("/api/logs", createLogsRouter({ rateLimiter: limiter }));
    app.use(errorHandler);

    await request(app).get("/api/logs").set("x-user-id", "u1").expect(200);
    // Limiter is shared, resetting it should free the bucket
    limiter.reset();
    await request(app).get("/api/logs").set("x-user-id", "u1").expect(200);
  });

  it("uses provided rateLimitOptions when no limiter is given", async () => {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    // capacity=1 via options
    app.use("/api/logs", createLogsRouter({ rateLimitOptions: { capacity: 1, refillRate: 1 } }));
    app.use(errorHandler);

    await request(app).get("/api/logs").set("x-user-id", "opts-user").expect(200);
    await request(app).get("/api/logs").set("x-user-id", "opts-user").expect(429);
  });
});
