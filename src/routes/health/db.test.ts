/**
 * Tests for Database Pool Stats Health Route
 *   src/routes/health/db.ts
 *
 * Covers:
 *   - GET / returns 200 with {status, timestamp, pool:{total,idle,waiting}}
 *   - Reading pool stats throws → next(InternalServerError) → error handler returns 500
 */

jest.mock("better-sqlite3", () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

// Mock ../../db.js before any imports that transitively pull it in.
// The module exports a Proxy named `pool`; we replace it with a plain object
// whose property accessors we can control per-test.
const mockPool = {
  totalCount: 5,
  idleCount: 3,
  waitingCount: 1,
};

jest.mock("../../db.js", () => ({
  pool: mockPool,
}));

import express from "express";
import request from "supertest";
import { createDbHealthRouter } from "./db.js";
import { errorHandler } from "../../middleware/errorHandler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/health/db", createDbHealthRouter());
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDbHealthRouter", () => {
  beforeEach(() => {
    // Restore default values before each test.
    mockPool.totalCount = 5;
    mockPool.idleCount = 3;
    mockPool.waitingCount = 1;
  });

  describe("GET /api/health/db", () => {
    it("returns 200 with status ok, a timestamp and pool stats", async () => {
      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(typeof res.body.timestamp).toBe("string");
      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    });

    it("returns pool.totalCount as pool.total", async () => {
      mockPool.totalCount = 10;
      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.body.pool.total).toBe(10);
    });

    it("returns pool.idleCount as pool.idle", async () => {
      mockPool.idleCount = 7;
      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.body.pool.idle).toBe(7);
    });

    it("returns pool.waitingCount as pool.waiting", async () => {
      mockPool.waitingCount = 2;
      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.body.pool.waiting).toBe(2);
    });

    it("returns all three pool stats in one request", async () => {
      mockPool.totalCount = 8;
      mockPool.idleCount = 4;
      mockPool.waitingCount = 0;

      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.status).toBe(200);
      expect(res.body.pool).toEqual({ total: 8, idle: 4, waiting: 0 });
    });

    it("returns zero counts correctly (pool at rest)", async () => {
      mockPool.totalCount = 0;
      mockPool.idleCount = 0;
      mockPool.waitingCount = 0;

      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.status).toBe(200);
      expect(res.body.pool).toEqual({ total: 0, idle: 0, waiting: 0 });
    });
  });

  describe("when reading pool stats throws", () => {
    it("calls next(InternalServerError) and the error handler returns 500", async () => {
      // Make reading totalCount throw to simulate a broken pool accessor.
      Object.defineProperty(mockPool, "totalCount", {
        get() {
          throw new Error("pool destroyed");
        },
        configurable: true,
      });

      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.status).toBe(500);

      // Restore for subsequent tests.
      Object.defineProperty(mockPool, "totalCount", {
        value: 5,
        writable: true,
        configurable: true,
      });
    });

    it("does not expose the internal error message in the 500 response body", async () => {
      Object.defineProperty(mockPool, "idleCount", {
        get() {
          throw new Error("secret connection string pg://admin:pw@host/db");
        },
        configurable: true,
      });

      const app = buildApp();
      const res = await request(app).get("/api/health/db");

      expect(res.status).toBe(500);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("pg://admin");

      Object.defineProperty(mockPool, "idleCount", {
        value: 3,
        writable: true,
        configurable: true,
      });
    });
  });
});
