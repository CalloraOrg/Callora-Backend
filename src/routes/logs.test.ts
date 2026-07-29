import express from "express";
import request from "supertest";
import logsRouter from "./logs.js";
import { getDefaultBreakerRegistry, CircuitBreakerState } from "../lib/circuitBreaker.js";
import { config } from "../config/index.js";
import { errorHandler } from "../middleware/errorHandler.js";

const app = express();
app.use(express.json());
app.use("/api/logs", logsRouter);
app.use(errorHandler);

const originalUpstreamUrl = config.proxy.upstreamUrl;

describe("GET /api/logs", () => {
  const breakerRegistry = getDefaultBreakerRegistry();

  beforeEach(async () => {
    // Reset all breakers before each test
    const breakers = await breakerRegistry.list();
    for (const b of breakers) {
      const breaker = breakerRegistry.get(b.slug);
      if (breaker) {
        await breaker.reset(b.slug);
      }
    }
  });

  afterAll(() => {
    // Restore config
    Object.assign(config.proxy, { upstreamUrl: originalUpstreamUrl });
  });

  it("returns 503 fast on open circuit breaker", async () => {
    // Point upstream to an invalid/failing URL to trigger circuit breaker failures
    Object.assign(config.proxy, { upstreamUrl: "http://localhost:1" });

    // The threshold in the logs route is 5. Let's make 5 failing requests
    for (let i = 0; i < 5; i++) {
      await request(app).get("/api/logs/test-endpoint").expect(502);
    }

    // Circuit should now be OPEN, making it fast-fail with 503
    const response = await request(app).get("/api/logs/test-endpoint").expect(503);
    
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
      },
    });
    expect(response.body.error.message).toMatch(/unavailable/i);
    
    // Verify breaker state is OPEN
    const state = await breakerRegistry.getState('logs-get-test-endpoint');
    expect(state).toBe(CircuitBreakerState.OPEN);
  });
});
