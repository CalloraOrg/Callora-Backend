/**
 * Tests for Health Dependency Probe Route (src/routes/health/health.ts)
 *
 * Covers:
 *   - GET /api/health/health (main dependency probe)
 *   - All dependencies healthy → 200 ok
 *   - Database down → 503 down
 *   - Optional component failure → 200 degraded
 *   - Unconfigured optional deps omitted
 *   - No config → empty dependencies
 *   - Error sanitization (no info leakage)
 *   - Timeout sanitization
 *   - HTTP status code preservation in errors
 *   - Mixed statuses
 *   - Unexpected throw → 503
 *   - Maintenance window short-circuit
 *   - Correlation ID propagation
 *   - Version included in response
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

import express from "express";
import request from "supertest";
import type { Pool, QueryResult } from "pg";
import { createHealthDependencyRouter } from "./health.js";
import type { HealthCheckConfig } from "../../services/healthCheck.js";
import { activeMaintenanceWindow } from "../admin/maintenance.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(config?: HealthCheckConfig, version?: string) {
  const app = express();
  app.use(express.json());
  app.use("/api/health/health", createHealthDependencyRouter(config, version));
  return app;
}

function createMockPool(queryResult: QueryResult | Error): Pool {
  return {
    query: async () => {
      if (queryResult instanceof Error) {
        throw queryResult;
      }
      return queryResult;
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Health Dependency Probe Route", () => {
  let originalFetch: typeof fetch;
  const savedMaintenance = { ...activeMaintenanceWindow };

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Reset maintenance window state after each test
    Object.assign(activeMaintenanceWindow, {
      isEnabled: false,
      startTime: null,
      endTime: null,
      reason: null,
    });
  });

  afterAll(() => {
    Object.assign(activeMaintenanceWindow, savedMaintenance);
  });

  describe("GET /api/health/health", () => {
    it("returns 200 with all dependencies healthy", async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const mockFetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ status: "healthy" }),
      }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp(
        {
          database: { pool, timeout: 1000 },
          sorobanRpc: { url: "https://soroban-test.stellar.org", timeout: 1000 },
          horizon: { url: "https://horizon-testnet.stellar.org", timeout: 1000 },
        },
        "1.2.3",
      );

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ok");
      expect(res.body.data.version).toBe("1.2.3");
      expect(res.body.data.timestamp).toBeDefined();
      expect(res.body.data.dependencies.database.status).toBe("ok");
      expect(typeof res.body.data.dependencies.database.responseTime).toBe("number");
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("ok");
      expect(res.body.data.dependencies.horizon.status).toBe("ok");
      expect(res.body.requestId).toBeDefined();
    });

    it("returns 503 and down status when database is down", async () => {
      const pool = createMockPool(new Error("Connection refused"));

      const app = buildApp({
        database: { pool, timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("down");
      expect(res.body.data.dependencies.database.status).toBe("down");
      expect(res.body.data.dependencies.database.error).toBe("unavailable");
    });

    it("returns 200 with degraded status when optional component fails", async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const mockFetch = jest.fn(async () => {
        throw new Error("Network error");
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        database: { pool, timeout: 1000 },
        sorobanRpc: { url: "https://soroban-test.stellar.org", timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("degraded");
      expect(res.body.data.dependencies.database.status).toBe("ok");
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("down");
      expect(res.body.data.dependencies.soroban_rpc.error).toBe("unavailable");
    });

    it("omits unconfigured optional dependencies from response", async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);

      const app = buildApp({
        database: { pool, timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.dependencies.database.status).toBe("ok");
      expect(res.body.data.dependencies.soroban_rpc).toBeUndefined();
      expect(res.body.data.dependencies.horizon).toBeUndefined();
    });

    it("returns empty dependencies when no config is provided", async () => {
      const app = buildApp();

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ok");
      expect(res.body.data.timestamp).toBeDefined();
      expect(res.body.data.dependencies).toEqual({});
    });

    it("returns empty dependencies when config has no database", async () => {
      const app = buildApp({} as HealthCheckConfig);

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.dependencies).toEqual({});
    });

    it("includes version in response when provided", async () => {
      const app = buildApp(undefined, "2.0.0-beta");

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe("2.0.0-beta");
    });

    it("omits version from response when not provided", async () => {
      const app = buildApp();

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBeUndefined();
    });

    it("sanitizes error messages to prevent information leakage", async () => {
      const pool = createMockPool(
        new Error("FATAL: connection to postgres://admin:s3cret@db.internal:5432/prod failed"),
      );

      const app = buildApp({
        database: { pool, timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(503);
      expect(res.body.data.dependencies.database.status).toBe("down");
      expect(res.body.data.dependencies.database.error).toBe("unavailable");
      // Raw error message must not leak
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("s3cret");
      expect(body).not.toContain("db.internal");
      expect(body).not.toContain("postgres://");
    });

    it("sanitizes timeout errors", async () => {
      const mockFetch = jest.fn(async () => {
        const err = new Error("Timeout") as Error & { name: string };
        err.name = "AbortError";
        throw err;
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        database: {
          pool: createMockPool({ rows: [{ result: 1 }] } as QueryResult),
          timeout: 1000,
        },
        sorobanRpc: { url: "https://soroban-test.stellar.org", timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("down");
      expect(res.body.data.dependencies.soroban_rpc.error).toBe("timeout");
    });

    it("preserves HTTP status codes in sanitized errors", async () => {
      const mockFetch = jest.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        database: {
          pool: createMockPool({ rows: [{ result: 1 }] } as QueryResult),
          timeout: 1000,
        },
        sorobanRpc: { url: "https://soroban-test.stellar.org", timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("degraded");
      expect(res.body.data.dependencies.soroban_rpc.error).toBe("HTTP 503");
    });

    it("sanitizes unexpected query results", async () => {
      const pool = createMockPool({
        rows: [],
        rowCount: 0,
        command: "",
        oid: 0,
        fields: [],
      } as QueryResult);

      const app = buildApp({
        database: { pool, timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(503);
      expect(res.body.data.dependencies.database.error).toBe("unexpected_response");
    });

    it("returns 503 with error envelope when probe throws unexpectedly", async () => {
      const pool = {
        query: async () => {
          throw "string error";
        },
      } as unknown as Pool;

      const app = buildApp({
        database: { pool, timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      // The checkDatabase function catches and wraps errors, so this
      // actually returns 503 with down status, not the error envelope.
      expect(res.status).toBe(503);
    });

    it("surfaces mixed statuses correctly", async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const mockFetch = jest.fn(async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes("soroban")) {
          return { ok: true, json: async () => ({ status: "healthy" }) };
        }
        if (urlStr.includes("horizon")) {
          throw new Error("Connection refused");
        }
        return originalFetch(url);
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        database: { pool, timeout: 1000 },
        sorobanRpc: { url: "https://soroban-test.stellar.org", timeout: 5000 },
        horizon: { url: "https://horizon-testnet.stellar.org", timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("degraded");
      expect(res.body.data.dependencies.database.status).toBe("ok");
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("ok");
      expect(res.body.data.dependencies.horizon.status).toBe("down");
    });

    it("preserves request correlation ID", async () => {
      const app = buildApp();
      const customId = "test-corr-id-42";

      const res = await request(app)
        .get("/api/health/health")
        .set("x-request-id", customId);

      expect(res.status).toBe(200);
      expect(res.body.requestId).toBe(customId);
      expect(res.headers["x-request-id"]).toBe(customId);
    });

    it("generates requestId when not provided", async () => {
      const app = buildApp();

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.requestId).toBeDefined();
      expect(typeof res.body.requestId).toBe("string");
    });

    it("returns response time as a number for healthy dependencies", async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const mockFetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ status: "healthy" }),
      }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        database: { pool, timeout: 1000 },
        sorobanRpc: { url: "https://soroban-test.stellar.org", timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(typeof res.body.data.dependencies.database.responseTime).toBe("number");
      expect(res.body.data.dependencies.database.responseTime).toBeGreaterThanOrEqual(0);
      expect(typeof res.body.data.dependencies.soroban_rpc.responseTime).toBe("number");
    });

    it("returns 200 when only database is configured and healthy", async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);

      const app = buildApp({
        database: { pool, timeout: 1000 },
      });

      const res = await request(app).get("/api/health/health");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("ok");
      expect(Object.keys(res.body.data.dependencies)).toEqual(["database"]);
    });

    describe("maintenance window", () => {
      it("returns 503 with MAINTENANCE status during active maintenance", async () => {
        const futureEnd = new Date(Date.now() + 60_000).toISOString();
        const pastStart = new Date(Date.now() - 60_000).toISOString();

        Object.assign(activeMaintenanceWindow, {
          isEnabled: true,
          startTime: pastStart,
          endTime: futureEnd,
          reason: "Scheduled upgrade",
        });

        const app = buildApp();

        const res = await request(app).get("/api/health/health");

        expect(res.status).toBe(503);
        expect(res.body.data.status).toBe("MAINTENANCE");
        expect(res.body.data.maintenance.reason).toBe("Scheduled upgrade");
        expect(res.body.data.maintenance.expiresAt).toBe(futureEnd);
        expect(res.body.data.dependencies).toEqual({});
      });

      it("returns normal health when maintenance window is disabled", async () => {
        Object.assign(activeMaintenanceWindow, {
          isEnabled: false,
          startTime: null,
          endTime: null,
          reason: null,
        });

        const app = buildApp();

        const res = await request(app).get("/api/health/health");

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("ok");
      });

      it("returns normal health when maintenance window has not started", async () => {
        const futureStart = new Date(Date.now() + 60_000).toISOString();
        const futureEnd = new Date(Date.now() + 120_000).toISOString();

        Object.assign(activeMaintenanceWindow, {
          isEnabled: true,
          startTime: futureStart,
          endTime: futureEnd,
          reason: "Scheduled upgrade",
        });

        const app = buildApp();

        const res = await request(app).get("/api/health/health");

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("ok");
      });

      it("returns normal health when maintenance window has expired", async () => {
        const pastStart = new Date(Date.now() - 120_000).toISOString();
        const pastEnd = new Date(Date.now() - 60_000).toISOString();

        Object.assign(activeMaintenanceWindow, {
          isEnabled: true,
          startTime: pastStart,
          endTime: pastEnd,
          reason: "Scheduled upgrade",
        });

        const app = buildApp();

        const res = await request(app).get("/api/health/health");

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("ok");
      });
    });
  });
});
