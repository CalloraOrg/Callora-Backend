import * as fs from "node:fs";
import * as path from "node:path";
import * as fc from "fast-check";
import { envSchema } from "./env.js";

// Minimal base env satisfying all required fields (no defaults)
const baseEnv = {
  JWT_SECRET: "test-secret",
  ADMIN_API_KEY: "test-admin-key",
  METRICS_API_KEY: "test-metrics-key",
};

describe("production secret strength", () => {
  it("rejects weak and placeholder secrets in production", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      NODE_ENV: "production",
      SOROBAN_BILLING_CONTRACT_ID: "contract",
      UPSTREAM_HOST_ALLOWLIST: "api.example.com",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.filter((issue) =>
        ["JWT_SECRET", "ADMIN_API_KEY", "METRICS_API_KEY"].includes(String(issue.path[0])),
      )).toHaveLength(3);
    }
  });

  it("accepts 32-byte production secrets", () => {
    const secret = "a".repeat(32);
    const result = envSchema.safeParse({
      ...baseEnv,
      JWT_SECRET: secret,
      ADMIN_API_KEY: "b".repeat(32),
      METRICS_API_KEY: "c".repeat(32),
      NODE_ENV: "production",
      SOROBAN_BILLING_CONTRACT_ID: "contract",
      UPSTREAM_HOST_ALLOWLIST: "api.example.com",
    });
    expect(result.success).toBe(true);
  });
});

describe("env schema — Soroban billing", () => {
  it("requires a nonempty contract ID in production", () => {
    for (const contractId of [undefined, "", "   "]) {
      const result = envSchema.safeParse({
        ...baseEnv,
        NODE_ENV: "production",
        SOROBAN_BILLING_CONTRACT_ID: contractId,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) =>
          issue.path[0] === "SOROBAN_BILLING_CONTRACT_ID",
        )).toBe(true);
      }
    }
  });

  it("accepts a valid production billing configuration", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      JWT_SECRET: "j".repeat(32),
      ADMIN_API_KEY: "a".repeat(32),
      METRICS_API_KEY: "m".repeat(32),
      NODE_ENV: "production",
      SOROBAN_BILLING_CONTRACT_ID: "contract_123",
      SOROBAN_BILLING_RPC_URL: "https://soroban.example.com",
      SOROBAN_BILLING_SOURCE_ACCOUNT: "source_123",
      SOROBAN_BILLING_NETWORK_PASSPHRASE: "Test network",
      SOROBAN_BILLING_BACKEND_SECRET_KEY: "secret_123",
      SOROBAN_BILLING_RPC_TIMEOUT_MS: "7500",
      SOROBAN_BILLING_BALANCE_FN: "get_balance",
      SOROBAN_BILLING_DEDUCT_FN: "charge",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SOROBAN_BILLING_CONTRACT_ID).toBe("contract_123");
      expect(result.data.SOROBAN_BILLING_RPC_TIMEOUT_MS).toBe(7500);
      expect(result.data.SOROBAN_BILLING_BALANCE_FN).toBe("get_balance");
      expect(result.data.SOROBAN_BILLING_DEDUCT_FN).toBe("charge");
    }
  });

  it("allows omitted billing configuration in development and test", () => {
    for (const nodeEnv of ["development", "test"]) {
      const result = envSchema.safeParse({ ...baseEnv, NODE_ENV: nodeEnv });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SOROBAN_BILLING_CONTRACT_ID).toBeUndefined();
        expect(result.data.SOROBAN_BILLING_RPC_TIMEOUT_MS).toBe(5000);
      }
    }
  });

  it("rejects invalid billing RPC settings", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      SOROBAN_BILLING_RPC_URL: "not-a-url",
      SOROBAN_BILLING_RPC_TIMEOUT_MS: "0",
      SOROBAN_BILLING_BALANCE_FN: "",
    });
    expect(result.success).toBe(false);
  });
});

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
      expect(result.data.RATE_LIMIT_OUTAGE_MODE).toBe('fail-closed');
      expect(result.data.RATE_LIMIT_FALLBACK_MAX_REQUESTS).toBe(10);
      expect(result.data.RATE_LIMIT_FALLBACK_WINDOW_MS).toBe(60_000);
      expect(result.data.RATE_LIMIT_FALLBACK_MAX_BUCKETS).toBe(10_000);
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

  it('accepts explicit fallback outage policy and bounds', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      RATE_LIMIT_STORE: 'postgres',
      RATE_LIMIT_OUTAGE_MODE: 'fallback',
      RATE_LIMIT_FALLBACK_MAX_REQUESTS: '7',
      RATE_LIMIT_FALLBACK_WINDOW_MS: '15000',
      RATE_LIMIT_FALLBACK_MAX_BUCKETS: '250',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.RATE_LIMIT_OUTAGE_MODE).toBe('fallback');
      expect(result.data.RATE_LIMIT_FALLBACK_MAX_REQUESTS).toBe(7);
      expect(result.data.RATE_LIMIT_FALLBACK_WINDOW_MS).toBe(15_000);
      expect(result.data.RATE_LIMIT_FALLBACK_MAX_BUCKETS).toBe(250);
    }
  });

  it('rejects an unsupported outage mode and unsafe fallback dimensions', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      RATE_LIMIT_OUTAGE_MODE: 'allow-all',
      RATE_LIMIT_FALLBACK_MAX_REQUESTS: '0',
      RATE_LIMIT_FALLBACK_WINDOW_MS: '-1',
      RATE_LIMIT_FALLBACK_MAX_BUCKETS: '0',
    });
    expect(result.success).toBe(false);
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

describe('env schema — upstream host allowlist', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('defaults to an empty allowlist in production', () => {
    process.env.NODE_ENV = 'production';
    const result = envSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(false);
  });

  it('requires UPSTREAM_ALLOWED_HOSTS in production', () => {
    process.env.NODE_ENV = 'production';
    const result = envSchema.safeParse({
      ...baseEnv,
      UPSTREAM_ALLOWED_HOSTS: 'api.example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.UPSTREAM_ALLOWED_HOSTS).toBe('api.example.com');
    }
  });

  it('defaults to loopback hosts in development', () => {
    process.env.NODE_ENV = 'development';
    const result = envSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.UPSTREAM_ALLOWED_HOSTS).toContain('localhost');
      expect(result.data.UPSTREAM_ALLOWED_HOSTS).toContain('127.0.0.1');
      expect(result.data.UPSTREAM_ALLOWED_HOSTS).toContain('::1');
    }
  });

  it('defaults to loopback hosts in test', () => {
    process.env.NODE_ENV = 'test';
    const result = envSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.UPSTREAM_ALLOWED_HOSTS).toContain('localhost');
    }
  });

  it('parses a comma-separated allowlist into an array', () => {
    process.env.NODE_ENV = 'production';
    const result = envSchema.safeParse({
      ...baseEnv,
      UPSTREAM_ALLOWED_HOSTS: 'api.example.com, api2.example.com',
    });
    expect(result.success).toBe((true));
    if (result.success) {
      expect(result.data.UPSTREAM_ALLOWED_HOSTS).toEqual(['api.example.com', 'api2.example.com']);
    }
  });

  it('rejects an empty UPSTREAM_ALLOWED_HOSTS in production', () => {
    process.env.NODE_ENV = 'production';
    const result = envSchema.safeParse({
      ...baseEnv,
      UPSTREAM_ALLOWED_HOSTS : '',
    });
    expect(result.success).toBe(false);
  });
});

describe("environment template parity", () => {
  const sourceRoot = path.resolve(process.cwd(), "src");
  const templatePath = path.resolve(process.cwd(), ".env.example");

  function sourceFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(filePath);
      return entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
        ? [filePath]
        : [];
    });
  }

  it("documents every process.env key read by application source", () => {
    const referencedKeys = new Set<string>();
    const processEnvKey = /process\.env\.([A-Z][A-Z0-9_]*)/g;

    for (const filePath of sourceFiles(sourceRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(processEnvKey)) referencedKeys.add(match[1]);
    }

    const documentedKeys = new Set(
      [...fs.readFileSync(templatePath, "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
        (match) => match[1],
      ),
    );
    const missingKeys = [...referencedKeys].filter((key) => !documentedKeys.has(key));

    expect(missingKeys).toEqual([]);
  });
});
