/**
 * Tests for Health Check Configuration Builder
 *   src/config/health.ts
 *
 * Covers:
 *   - buildHealthCheckConfig() returns undefined when DB_HOST=localhost and DB_NAME=callora
 *   - buildHealthCheckConfig() returns a full HealthCheckConfig otherwise
 *   - sorobanRpc is only included when SOROBAN_RPC_ENABLED=true and SOROBAN_RPC_URL is set
 *   - horizon is only included when HORIZON_ENABLED=true and HORIZON_URL is set
 *   - Repeated calls reuse the same pg.Pool instance (lazy singleton)
 *   - closeDbPool() calls pool.end() exactly once
 *   - closeDbPool() is safe to call a second time (no-op)
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

// ---------------------------------------------------------------------------
// pg mock – must be declared before any module that imports `pg`
// ---------------------------------------------------------------------------

const mockEnd = jest.fn().mockResolvedValue(undefined);
const MockPool = jest.fn().mockImplementation(() => ({ end: mockEnd }));

jest.mock("pg", () => ({ Pool: MockPool }));

// ---------------------------------------------------------------------------
// env mock – we override the returned `env` object per test via the factory
// ---------------------------------------------------------------------------

// A base env that makes buildHealthCheckConfig return a config
// (DB_HOST is not 'localhost' or DB_NAME is not 'callora').
const baseEnv = {
  DB_HOST: "db.production.internal",
  DB_PORT: 5432,
  DB_USER: "appuser",
  DB_PASSWORD: "s3cret",
  DB_NAME: "calloradb",
  DB_POOL_MAX: 10,
  DB_IDLE_TIMEOUT_MS: 30_000,
  DB_CONN_TIMEOUT_MS: 2_000,
  HEALTH_CHECK_DB_TIMEOUT: 2_000,
  APP_VERSION: "1.2.3",
  SOROBAN_RPC_ENABLED: false,
  SOROBAN_RPC_URL: undefined as string | undefined,
  SOROBAN_RPC_TIMEOUT: 2_000,
  HORIZON_ENABLED: false,
  HORIZON_URL: undefined as string | undefined,
  HORIZON_TIMEOUT: 2_000,
};

// Mutable copy that individual tests can override.
let currentEnv = { ...baseEnv };

jest.mock("./env.js", () => ({
  get env() {
    return currentEnv;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { buildHealthCheckConfig, closeDbPool } from "./health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resets the lazy dbPool singleton stored inside health.ts between tests.
 *
 * health.ts captures a module-level `let dbPool: Pool | null = null`.
 * We reset it by calling closeDbPool() (which sets it to null) before each
 * test, and clearing the MockPool / mockEnd call history afterwards.
 */
async function resetModule() {
  await closeDbPool();
  MockPool.mockClear();
  mockEnd.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildHealthCheckConfig", () => {
  beforeEach(async () => {
    currentEnv = { ...baseEnv };
    await resetModule();
  });

  // ── default localhost/callora → undefined ─────────────────────────────────

  describe("returns undefined when database is not configured for health checks", () => {
    it("returns undefined when DB_HOST is 'localhost' and DB_NAME is 'callora'", () => {
      currentEnv = {
        ...baseEnv,
        DB_HOST: "localhost",
        DB_NAME: "callora",
      };

      const result = buildHealthCheckConfig();

      expect(result).toBeUndefined();
      expect(MockPool).not.toHaveBeenCalled();
    });

    it("returns a config when DB_HOST is 'localhost' but DB_NAME differs", () => {
      currentEnv = { ...baseEnv, DB_HOST: "localhost", DB_NAME: "production_db" };
      const result = buildHealthCheckConfig();
      expect(result).not.toBeUndefined();
    });

    it("returns a config when DB_NAME is 'callora' but DB_HOST differs", () => {
      currentEnv = { ...baseEnv, DB_HOST: "db.example.com", DB_NAME: "callora" };
      const result = buildHealthCheckConfig();
      expect(result).not.toBeUndefined();
    });
  });

  // ── full config ───────────────────────────────────────────────────────────

  describe("returns a HealthCheckConfig when database is configured", () => {
    it("creates a pg.Pool with the env-derived connection settings", () => {
      buildHealthCheckConfig();

      expect(MockPool).toHaveBeenCalledTimes(1);
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "db.production.internal",
          port: 5432,
          user: "appuser",
          password: "s3cret",
          database: "calloradb",
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 2_000,
        }),
      );
    });

    it("returns config with the correct version", () => {
      const result = buildHealthCheckConfig();
      expect(result?.version).toBe("1.2.3");
    });

    it("returns config with the correct db timeout", () => {
      currentEnv = { ...baseEnv, HEALTH_CHECK_DB_TIMEOUT: 5_000 };
      const result = buildHealthCheckConfig();
      expect(result?.database.timeout).toBe(5_000);
    });

    it("does not include sorobanRpc when SOROBAN_RPC_ENABLED is false", () => {
      const result = buildHealthCheckConfig();
      expect(result?.sorobanRpc).toBeUndefined();
    });

    it("does not include horizon when HORIZON_ENABLED is false", () => {
      const result = buildHealthCheckConfig();
      expect(result?.horizon).toBeUndefined();
    });
  });

  // ── optional soroban ──────────────────────────────────────────────────────

  describe("sorobanRpc inclusion", () => {
    it("includes sorobanRpc when SOROBAN_RPC_ENABLED=true and SOROBAN_RPC_URL is set", () => {
      currentEnv = {
        ...baseEnv,
        SOROBAN_RPC_ENABLED: true,
        SOROBAN_RPC_URL: "https://soroban.example.com",
        SOROBAN_RPC_TIMEOUT: 3_000,
      };

      const result = buildHealthCheckConfig();

      expect(result?.sorobanRpc).toEqual({
        url: "https://soroban.example.com",
        timeout: 3_000,
      });
    });

    it("does not include sorobanRpc when SOROBAN_RPC_ENABLED=true but URL is undefined", () => {
      currentEnv = {
        ...baseEnv,
        SOROBAN_RPC_ENABLED: true,
        SOROBAN_RPC_URL: undefined,
      };

      const result = buildHealthCheckConfig();
      expect(result?.sorobanRpc).toBeUndefined();
    });

    it("does not include sorobanRpc when URL is set but SOROBAN_RPC_ENABLED=false", () => {
      currentEnv = {
        ...baseEnv,
        SOROBAN_RPC_ENABLED: false,
        SOROBAN_RPC_URL: "https://soroban.example.com",
      };

      const result = buildHealthCheckConfig();
      expect(result?.sorobanRpc).toBeUndefined();
    });
  });

  // ── optional horizon ──────────────────────────────────────────────────────

  describe("horizon inclusion", () => {
    it("includes horizon when HORIZON_ENABLED=true and HORIZON_URL is set", () => {
      currentEnv = {
        ...baseEnv,
        HORIZON_ENABLED: true,
        HORIZON_URL: "https://horizon.example.com",
        HORIZON_TIMEOUT: 4_000,
      };

      const result = buildHealthCheckConfig();

      expect(result?.horizon).toEqual({
        url: "https://horizon.example.com",
        timeout: 4_000,
      });
    });

    it("does not include horizon when HORIZON_ENABLED=true but URL is undefined", () => {
      currentEnv = {
        ...baseEnv,
        HORIZON_ENABLED: true,
        HORIZON_URL: undefined,
      };

      const result = buildHealthCheckConfig();
      expect(result?.horizon).toBeUndefined();
    });

    it("does not include horizon when URL is set but HORIZON_ENABLED=false", () => {
      currentEnv = {
        ...baseEnv,
        HORIZON_ENABLED: false,
        HORIZON_URL: "https://horizon.example.com",
      };

      const result = buildHealthCheckConfig();
      expect(result?.horizon).toBeUndefined();
    });
  });

  // ── all optional deps together ────────────────────────────────────────────

  describe("full config with all optional deps", () => {
    it("builds config with database, sorobanRpc and horizon all present", () => {
      currentEnv = {
        ...baseEnv,
        SOROBAN_RPC_ENABLED: true,
        SOROBAN_RPC_URL: "https://soroban.example.com",
        HORIZON_ENABLED: true,
        HORIZON_URL: "https://horizon.example.com",
      };

      const result = buildHealthCheckConfig();

      expect(result?.database).toBeDefined();
      expect(result?.sorobanRpc).toBeDefined();
      expect(result?.horizon).toBeDefined();
    });
  });

  // ── lazy pool singleton ───────────────────────────────────────────────────

  describe("lazy pool singleton", () => {
    it("creates the pg.Pool only once across repeated calls", () => {
      buildHealthCheckConfig();
      buildHealthCheckConfig();
      buildHealthCheckConfig();

      expect(MockPool).toHaveBeenCalledTimes(1);
    });

    it("reuses the same pool instance on the second call", () => {
      const first = buildHealthCheckConfig();
      const second = buildHealthCheckConfig();

      expect(first?.database.pool).toBe(second?.database.pool);
    });
  });
});

// ---------------------------------------------------------------------------
// closeDbPool tests
// ---------------------------------------------------------------------------

describe("closeDbPool", () => {
  beforeEach(async () => {
    currentEnv = { ...baseEnv };
    await resetModule();
  });

  it("calls pool.end() exactly once when a pool exists", async () => {
    buildHealthCheckConfig(); // creates the pool
    await closeDbPool();

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (does not throw) when called before any pool is created", async () => {
    await expect(closeDbPool()).resolves.toBeUndefined();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("is safe to call a second time without calling end() again", async () => {
    buildHealthCheckConfig();
    await closeDbPool();
    await closeDbPool(); // second call must not throw or call end again

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("clears the pool reference so buildHealthCheckConfig creates a new one afterwards", async () => {
    buildHealthCheckConfig();
    await closeDbPool();
    MockPool.mockClear(); // clear the creation count

    buildHealthCheckConfig(); // should create a fresh pool
    expect(MockPool).toHaveBeenCalledTimes(1);
  });
});
