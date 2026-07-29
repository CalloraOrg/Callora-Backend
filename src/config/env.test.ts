import * as fc from "fast-check";
import { envSchema } from "./env.js";

// Minimal base env satisfying all required fields (no defaults)
const baseEnv = {
  JWT_SECRET: "test-secret",
  ADMIN_API_KEY: "test-admin-key",
  METRICS_API_KEY: "test-metrics-key",
};

describe("env schema - BCRYPT_COST_FACTOR", () => {
  describe("unit tests", () => {
    it("defaults to 12 when BCRYPT_COST_FACTOR is omitted", () => {
      const result = envSchema.safeParse({ ...baseEnv });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.BCRYPT_COST_FACTOR).toBe(12);
      }
    });

    it("accepts the minimum boundary value 10", () => {
      const result = envSchema.safeParse({
        ...baseEnv,
        BCRYPT_COST_FACTOR: "10",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.BCRYPT_COST_FACTOR).toBe(10);
      }
    });

    it("accepts the maximum boundary value 31", () => {
      const result = envSchema.safeParse({
        ...baseEnv,
        BCRYPT_COST_FACTOR: "31",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.BCRYPT_COST_FACTOR).toBe(31);
      }
    });

    it("rejects value 9 (one below minimum)", () => {
      const result = envSchema.safeParse({
        ...baseEnv,
        BCRYPT_COST_FACTOR: "9",
      });
      expect(result.success).toBe(false);
    });

    it("rejects value 32 (one above maximum)", () => {
      const result = envSchema.safeParse({
        ...baseEnv,
        BCRYPT_COST_FACTOR: "32",
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer string "abc"', () => {
      const result = envSchema.safeParse({
        ...baseEnv,
        BCRYPT_COST_FACTOR: "abc",
      });
      expect(result.success).toBe(false);
    });
  });

  it("Property 1: valid cost factor parses to the correct integer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 31 }), (n) => {
        const result = envSchema.safeParse({
          ...baseEnv,
          BCRYPT_COST_FACTOR: String(n),
        });
        return result.success && result.data.BCRYPT_COST_FACTOR === n;
      }),
      { numRuns: 100 },
    );
  });

  it("Property 2: out-of-range values are rejected", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ max: 9 }), fc.integer({ min: 32 })),
        (n) => {
          const result = envSchema.safeParse({
            ...baseEnv,
            BCRYPT_COST_FACTOR: String(n),
          });
          return !result.success;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 3: non-numeric strings are rejected", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => isNaN(Number(s))),
        (s) => {
          const result = envSchema.safeParse({
            ...baseEnv,
            BCRYPT_COST_FACTOR: s,
          });
          return !result.success;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('env schema — REST rate limit config', () => {
  it('defaults REST rate limiting values when omitted', () => {
    const result = envSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.REST_RATE_LIMIT_WINDOW_MS).toBe(60_000);
      expect(result.data.REST_RATE_LIMIT_MAX_REQUESTS).toBe(100);
    }
  });

  it('accepts positive integer REST rate limit values', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      REST_RATE_LIMIT_WINDOW_MS: '15000',
      REST_RATE_LIMIT_MAX_REQUESTS: '12',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.REST_RATE_LIMIT_WINDOW_MS).toBe(15_000);
      expect(result.data.REST_RATE_LIMIT_MAX_REQUESTS).toBe(12);
    }
  });

  it('rejects non-positive REST rate limit values', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      REST_RATE_LIMIT_WINDOW_MS: '0',
      REST_RATE_LIMIT_MAX_REQUESTS: '-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('env schema — gateway rate limit config', () => {
  it('defaults gateway rate limit values when omitted', () => {
    const result = envSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RATE_LIMIT_MAX_REQUESTS).toBe(5);
      expect(result.data.RATE_LIMIT_WINDOW_MS).toBe(60_000);
      expect(result.data.RATE_LIMIT_STORE).toBe('memory');
      expect(result.data.RATE_LIMIT_PG_TABLE).toBe('gateway_rate_limit_buckets');
    }
  });

  it('accepts explicit postgres store configuration', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      RATE_LIMIT_MAX_REQUESTS: '50',
      RATE_LIMIT_WINDOW_MS: '10000',
      RATE_LIMIT_STORE: 'postgres',
      RATE_LIMIT_PG_TABLE: 'custom_rate_limit_buckets',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RATE_LIMIT_MAX_REQUESTS).toBe(50);
      expect(result.data.RATE_LIMIT_WINDOW_MS).toBe(10_000);
      expect(result.data.RATE_LIMIT_STORE).toBe('postgres');
      expect(result.data.RATE_LIMIT_PG_TABLE).toBe('custom_rate_limit_buckets');
    }
  });

  it('rejects a store value other than "memory" or "postgres"', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      RATE_LIMIT_STORE: 'redis',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive RATE_LIMIT_MAX_REQUESTS', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      RATE_LIMIT_MAX_REQUESTS: '0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a table name with characters outside [A-Za-z0-9_]', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      RATE_LIMIT_PG_TABLE: 'buckets; DROP TABLE users;',
    });
    expect(result.success).toBe(false);
  });
});

describe('env schema — revenue ledger indexer config', () => {
  it('defaults revenue ledger indexer values when omitted', () => {
    const result = envSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.REVENUE_LEDGER_INDEXER_INTERVAL_MS).toBe(30_000);
      expect(result.data.REVENUE_LEDGER_INDEXER_BATCH_SIZE).toBe(500);
    }
  });

  it('rejects non-positive revenue ledger indexer values', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      REVENUE_LEDGER_INDEXER_INTERVAL_MS: '0',
      REVENUE_LEDGER_INDEXER_BATCH_SIZE: '-10',
    });
    expect(result.success).toBe(false);
  });
});
