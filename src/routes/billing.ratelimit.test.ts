import express from "express";
import request from "supertest";
import {
  createBillingRateLimitMiddleware,
  InMemoryRateLimiter,
} from "../middleware/rateLimit.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";

describe("Per-user billing rate limiting", () => {
  function buildApp(limiter?: InMemoryRateLimiter) {
    const app = express();
    app.use(requestIdMiddleware);

    // Create a billing rate limiter with a small window for testing
    const testLimiter = limiter ?? new InMemoryRateLimiter(60_000, 3);
    app.use(
      "/api/billing",
      createBillingRateLimitMiddleware(
        { windowMs: 60_000, maxRequests: 3 },
        testLimiter,
      ),
    );

    // Simple test route that always returns 200
    app.get("/api/billing/test", (req, res) => {
      res.status(200).json({ message: "OK" });
    });

    app.use(errorHandler);
    return app;
  }

  it("allows requests within the rate limit per user", async () => {
    const app = buildApp();

    // User makes 3 requests within the limit
    let res = await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    expect(res.body.message).toBe("OK");

    res = await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    expect(res.body.message).toBe("OK");

    res = await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    expect(res.body.message).toBe("OK");
  });

  it("rejects requests that exceed the per-user rate limit", async () => {
    const app = buildApp();

    // Make 3 requests (all succeed)
    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    // 4th request exceeds the limit
    const res = await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1");

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("independently rate limits different authenticated users", async () => {
    const app = buildApp();

    // User 1 makes 3 requests (all succeed)
    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    // User 1's 4th request fails
    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(429);

    // But user 2 can still make requests
    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-2")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-2")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-2")
      .expect(200);

    // User 2's 4th request also fails
    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-2")
      .expect(429);
  });

  it("falls back to IP-based rate limiting for unauthenticated requests", async () => {
    const app = buildApp();

    // Unauthenticated request 1 (succeeds)
    await request(app).get("/api/billing/test").expect(200);

    // Unauthenticated request 2 (succeeds)
    await request(app).get("/api/billing/test").expect(200);

    // Unauthenticated request 3 (succeeds)
    await request(app).get("/api/billing/test").expect(200);

    // Unauthenticated request 4 (fails due to IP-based limit)
    await request(app).get("/api/billing/test").expect(429);
  });

  it("includes Retry-After header on rate limit exceeded", async () => {
    const app = buildApp();

    // Exhaust limit
    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200);

    // Check Retry-After is present
    const res = await request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    const retryAfter = parseInt(res.headers["retry-after"] as string, 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60); // Window is 60 seconds
  });

  it("resets bucket state after window expires", (done) => {
    // Use a custom short window for this test
    const testLimiter = new InMemoryRateLimiter(100, 2); // 100ms window, 2 requests max
    const app = buildApp(testLimiter);

    // Make 2 requests (both succeed)
    request(app)
      .get("/api/billing/test")
      .set("x-user-id", "user-1")
      .expect(200, () => {
        request(app)
          .get("/api/billing/test")
          .set("x-user-id", "user-1")
          .expect(200, () => {
            // 3rd request fails (window not expired yet)
            request(app)
              .get("/api/billing/test")
              .set("x-user-id", "user-1")
              .expect(429, () => {
                // Wait for window to expire, then retry
                setTimeout(() => {
                  request(app)
                    .get("/api/billing/test")
                    .set("x-user-id", "user-1")
                    .expect(200, done);
                }, 150);
              });
          });
      });
  });
});
