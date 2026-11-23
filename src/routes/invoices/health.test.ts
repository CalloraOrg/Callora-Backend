/**
 * Tests for Invoices Health Dependency Probe Route
 *   src/routes/invoices/health.ts
 *
 * Covers:
 *   - No config → 200 {status:'ok', dependencies:{}}
 *   - All dependencies healthy → 200 ok
 *   - Degraded dependency → 200 degraded
 *   - Critical dependency down → 503 down
 *   - sanitizeDependencyCheck: each error mapping
 *   - Unexpected throw inside handler → 503 SERVICE_UNAVAILABLE envelope
 *   - x-request-id header is set on every response
 *   - Correlation ID propagation
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

// Mock the healthCheck service so no real DB/network calls are made.
jest.mock("../../services/healthCheck.js", () => ({
  checkDatabase: jest.fn(),
  checkSorobanRpc: jest.fn(),
  checkHorizon: jest.fn(),
  determineOverallStatus: jest.fn(),
}));

import express from "express";
import request from "supertest";
import {
  createInvoicesHealthRouter,
  sanitizeDependencyCheck,
} from "./health.js";
import type { InvoicesHealthDeps } from "./health.js";
import type { HealthCheckConfig, ComponentCheck } from "../../services/healthCheck.js";
import {
  checkDatabase,
  checkSorobanRpc,
  checkHorizon,
  determineOverallStatus,
} from "../../services/healthCheck.js";

const mockCheckDatabase = checkDatabase as jest.MockedFunction<typeof checkDatabase>;
const mockCheckSorobanRpc = checkSorobanRpc as jest.MockedFunction<typeof checkSorobanRpc>;
const mockCheckHorizon = checkHorizon as jest.MockedFunction<typeof checkHorizon>;
const mockDetermineOverallStatus = determineOverallStatus as jest.MockedFunction<
  typeof determineOverallStatus
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake pg Pool; never actually called (checkDatabase is mocked). */
function fakePool() {
  return {} as unknown as HealthCheckConfig["database"]["pool"];
}

function buildConfig(overrides: Partial<HealthCheckConfig> = {}): HealthCheckConfig {
  return {
    version: "1.0.0",
    database: { pool: fakePool(), timeout: 1000 },
    ...overrides,
  };
}

function buildApp(deps: InvoicesHealthDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/invoices/health", createInvoicesHealthRouter(deps));
  return app;
}

function okCheck(overrides: Partial<ComponentCheck> = {}): ComponentCheck {
  return { status: "ok", responseTime: 5, ...overrides };
}

function downCheck(error: string): ComponentCheck {
  return { status: "down", responseTime: 10, error };
}

// ---------------------------------------------------------------------------
// sanitizeDependencyCheck unit tests
// ---------------------------------------------------------------------------

describe("sanitizeDependencyCheck", () => {
  it("passes through status and responseTime when no error", () => {
    const result = sanitizeDependencyCheck({ status: "ok", responseTime: 42 });
    expect(result).toEqual({ status: "ok", responseTime: 42 });
  });

  it("omits responseTime when undefined", () => {
    const result = sanitizeDependencyCheck({ status: "ok" });
    expect(result).toEqual({ status: "ok" });
    expect(Object.prototype.hasOwnProperty.call(result, "responseTime")).toBe(false);
  });

  it("maps 'Timeout' to 'timeout'", () => {
    expect(sanitizeDependencyCheck(downCheck("Timeout")).error).toBe("timeout");
  });

  it("maps 'Database check timeout' to 'timeout'", () => {
    expect(sanitizeDependencyCheck(downCheck("Database check timeout")).error).toBe("timeout");
  });

  it("passes through 'HTTP <code>' errors verbatim", () => {
    expect(sanitizeDependencyCheck(downCheck("HTTP 502")).error).toBe("HTTP 502");
    expect(sanitizeDependencyCheck(downCheck("HTTP 503")).error).toBe("HTTP 503");
  });

  it("maps 'Unexpected query result' to 'unexpected_response'", () => {
    expect(sanitizeDependencyCheck(downCheck("Unexpected query result")).error).toBe(
      "unexpected_response",
    );
  });

  it("passes through 'network_mismatch' verbatim", () => {
    expect(sanitizeDependencyCheck(downCheck("network_mismatch")).error).toBe("network_mismatch");
  });

  it("passes through 'vault_contract_missing' verbatim", () => {
    expect(
      sanitizeDependencyCheck(downCheck("vault_contract_missing")).error,
    ).toBe("vault_contract_missing");
  });

  it("maps any other error message to 'unavailable'", () => {
    expect(
      sanitizeDependencyCheck(downCheck("FATAL: password auth failed for user postgres")).error,
    ).toBe("unavailable");
    expect(sanitizeDependencyCheck(downCheck("Connection refused")).error).toBe("unavailable");
    expect(sanitizeDependencyCheck(downCheck("Unknown error")).error).toBe("unavailable");
  });

  it("omits error field when check has no error", () => {
    const result = sanitizeDependencyCheck({ status: "ok", responseTime: 1 });
    expect(Object.prototype.hasOwnProperty.call(result, "error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createInvoicesHealthRouter integration tests
// ---------------------------------------------------------------------------

describe("createInvoicesHealthRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── no-config path ────────────────────────────────────────────────────────

  describe("no config (config.database is absent)", () => {
    it("returns 200 with status ok and empty dependencies when config is undefined", async () => {
      const app = buildApp({ config: undefined as unknown as HealthCheckConfig });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ok");
      expect(res.body.data.dependencies).toEqual({});
      expect(res.body.data.timestamp).toBeDefined();
    });

    it("returns 200 with empty dependencies when config has no database field", async () => {
      const app = buildApp({ config: {} as HealthCheckConfig });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("ok");
      expect(res.body.data.dependencies).toEqual({});
      expect(mockCheckDatabase).not.toHaveBeenCalled();
    });

    it("sets x-request-id header on the no-config path", async () => {
      const app = buildApp({ config: undefined as unknown as HealthCheckConfig });
      const res = await request(app).get("/api/invoices/health");

      expect(res.headers["x-request-id"]).toBeDefined();
      expect(typeof res.headers["x-request-id"]).toBe("string");
    });

    it("reflects a supplied x-request-id on the no-config path", async () => {
      const app = buildApp({ config: undefined as unknown as HealthCheckConfig });
      const res = await request(app)
        .get("/api/invoices/health")
        .set("x-request-id", "no-config-corr-id");

      expect(res.headers["x-request-id"]).toBe("no-config-corr-id");
      expect(res.body.requestId).toBe("no-config-corr-id");
    });
  });

  // ── all-ok path ───────────────────────────────────────────────────────────

  describe("all dependencies healthy", () => {
    it("returns 200 with status ok and correct dependency entries", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockDetermineOverallStatus.mockReturnValue("ok");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ok");
      expect(res.body.data.dependencies.database.status).toBe("ok");
      expect(typeof res.body.data.dependencies.database.responseTime).toBe("number");
      expect(res.body.data.dependencies.soroban_rpc).toBeUndefined();
      expect(res.body.data.dependencies.horizon).toBeUndefined();
    });

    it("includes version in the response body when configured", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockDetermineOverallStatus.mockReturnValue("ok");

      const app = buildApp({ config: buildConfig({ version: "2.3.4" }) });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.version).toBe("2.3.4");
    });

    it("sets x-request-id header when all deps are ok", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockDetermineOverallStatus.mockReturnValue("ok");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.headers["x-request-id"]).toBeDefined();
    });

    it("propagates a supplied x-request-id header through to response", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockDetermineOverallStatus.mockReturnValue("ok");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app)
        .get("/api/invoices/health")
        .set("x-request-id", "my-corr-id-99");

      expect(res.headers["x-request-id"]).toBe("my-corr-id-99");
      expect(res.body.requestId).toBe("my-corr-id-99");
    });

    it("includes all three optional dependencies when soroban and horizon are configured", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockCheckSorobanRpc.mockResolvedValue(okCheck());
      mockCheckHorizon.mockResolvedValue(okCheck());
      mockDetermineOverallStatus.mockReturnValue("ok");

      const config = buildConfig({
        sorobanRpc: { url: "https://soroban.example.com", timeout: 1000 },
        horizon: { url: "https://horizon.example.com", timeout: 1000 },
      });

      const app = buildApp({ config });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(200);
      expect(res.body.data.dependencies.database.status).toBe("ok");
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("ok");
      expect(res.body.data.dependencies.horizon.status).toBe("ok");
    });
  });

  // ── degraded path ─────────────────────────────────────────────────────────

  describe("degraded dependency", () => {
    it("returns 200 with degraded overall status when soroban is degraded", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockCheckSorobanRpc.mockResolvedValue({
        status: "degraded",
        responseTime: 50,
        error: "HTTP 503",
      });
      mockDetermineOverallStatus.mockReturnValue("degraded");

      const config = buildConfig({
        sorobanRpc: { url: "https://soroban.example.com", timeout: 1000 },
      });

      const app = buildApp({ config });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("degraded");
      expect(res.body.data.dependencies.soroban_rpc.status).toBe("degraded");
      expect(res.body.data.dependencies.soroban_rpc.error).toBe("HTTP 503");
    });

    it("returns 200 degraded when horizon is degraded", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockCheckHorizon.mockResolvedValue({
        status: "degraded",
        responseTime: 20,
        error: "HTTP 502",
      });
      mockDetermineOverallStatus.mockReturnValue("degraded");

      const config = buildConfig({
        horizon: { url: "https://horizon.example.com", timeout: 1000 },
      });

      const app = buildApp({ config });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("degraded");
      expect(res.body.data.dependencies.horizon.error).toBe("HTTP 502");
    });
  });

  // ── down / 503 path ───────────────────────────────────────────────────────

  describe("database down", () => {
    it("returns 503 when determineOverallStatus returns 'down'", async () => {
      mockCheckDatabase.mockResolvedValue({
        status: "down",
        responseTime: 10,
        error: "Connection refused",
      });
      mockDetermineOverallStatus.mockReturnValue("down");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("down");
      expect(res.body.data.dependencies.database.status).toBe("down");
      expect(res.body.data.dependencies.database.error).toBe("unavailable");
    });

    it("sanitizes raw connection strings out of database error messages", async () => {
      mockCheckDatabase.mockResolvedValue({
        status: "down",
        responseTime: 10,
        error: "FATAL: password auth failed for user postgres at host db.internal",
      });
      mockDetermineOverallStatus.mockReturnValue("down");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(503);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("db.internal");
      expect(body).not.toContain("postgres at host");
      expect(res.body.data.dependencies.database.error).toBe("unavailable");
    });
  });

  // ── error sanitisation per mapped message ─────────────────────────────────

  describe("error sanitisation via sanitizeDependencyCheck", () => {
    it("maps 'Database check timeout' error to 'timeout'", async () => {
      mockCheckDatabase.mockResolvedValue(downCheck("Database check timeout"));
      mockDetermineOverallStatus.mockReturnValue("down");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.database.error).toBe("timeout");
    });

    it("maps 'Timeout' error to 'timeout'", async () => {
      mockCheckDatabase.mockResolvedValue(downCheck("Timeout"));
      mockDetermineOverallStatus.mockReturnValue("down");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.database.error).toBe("timeout");
    });

    it("passes through 'HTTP 502' verbatim", async () => {
      mockCheckDatabase.mockResolvedValue({
        status: "degraded",
        responseTime: 5,
        error: "HTTP 502",
      });
      mockDetermineOverallStatus.mockReturnValue("degraded");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.database.error).toBe("HTTP 502");
    });

    it("maps 'Unexpected query result' to 'unexpected_response'", async () => {
      mockCheckDatabase.mockResolvedValue(downCheck("Unexpected query result"));
      mockDetermineOverallStatus.mockReturnValue("down");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.database.error).toBe("unexpected_response");
    });

    it("passes through 'network_mismatch' verbatim on soroban check", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockCheckSorobanRpc.mockResolvedValue({
        status: "degraded",
        responseTime: 5,
        error: "network_mismatch",
      });
      mockDetermineOverallStatus.mockReturnValue("degraded");

      const config = buildConfig({
        sorobanRpc: { url: "https://soroban.example.com", timeout: 1000 },
      });

      const app = buildApp({ config });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.soroban_rpc.error).toBe("network_mismatch");
    });

    it("passes through 'vault_contract_missing' verbatim on soroban check", async () => {
      mockCheckDatabase.mockResolvedValue(okCheck());
      mockCheckSorobanRpc.mockResolvedValue({
        status: "degraded",
        responseTime: 5,
        error: "vault_contract_missing",
      });
      mockDetermineOverallStatus.mockReturnValue("degraded");

      const config = buildConfig({
        sorobanRpc: { url: "https://soroban.example.com", timeout: 1000 },
      });

      const app = buildApp({ config });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.soroban_rpc.error).toBe("vault_contract_missing");
    });

    it("does not include error field when responseTime is undefined and status is ok", async () => {
      mockCheckDatabase.mockResolvedValue({ status: "ok" });
      mockDetermineOverallStatus.mockReturnValue("ok");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.body.data.dependencies.database.error).toBeUndefined();
      expect(res.body.data.dependencies.database.responseTime).toBeUndefined();
    });
  });

  // ── unexpected throw → 503 SERVICE_UNAVAILABLE envelope ──────────────────

  describe("unexpected throw from checkDatabase", () => {
    it("returns 503 error envelope when checkDatabase throws synchronously", async () => {
      mockCheckDatabase.mockImplementation(() => {
        throw new Error("Catastrophic internal failure");
      });

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
      expect(res.body.error.message).toBe("Invoices health probe failed");
    });

    it("returns 503 error envelope when checkDatabase rejects with a non-Error value", async () => {
      mockCheckDatabase.mockRejectedValue("string rejection");

      const app = buildApp({ config: buildConfig() });
      const res = await request(app).get("/api/invoices/health");

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("sets requestId in the error envelope", async () => {
      mockCheckDatabase.mockRejectedValue(new Error("boom"));

      const app = buildApp({ config: buildConfig() });
      const res = await request(app)
        .get("/api/invoices/health")
        .set("x-request-id", "err-corr-id");

      expect(res.status).toBe(503);
      expect(res.body.requestId).toBe("err-corr-id");
    });

    it("sets x-request-id header even when the handler throws", async () => {
      mockCheckDatabase.mockRejectedValue(new Error("boom"));

      const app = buildApp({ config: buildConfig() });
      const res = await request(app)
        .get("/api/invoices/health")
        .set("x-request-id", "throw-corr-id");

      expect(res.headers["x-request-id"]).toBe("throw-corr-id");
    });
  });
});
