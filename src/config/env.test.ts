import * as fc from "fast-check";
import { envSchema } from "./env";

// Minimal base env satisfying all required fields (no defaults)
const baseEnv = {
  JWT_SECRET: "test-secret",
  ADMIN_API_KEY: "test-admin-key",
  METRICS_API_KEY: "test-metrics-key",
};

describe("env schema — BCRYPT_COST_FACTOR", () => {
  // ── Unit Tests (Task 1.4) ──────────────────────────────────────────────────

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

  // ── Property-Based Tests ───────────────────────────────────────────────────

  // Feature: bcrypt-cost-config, Property 1: valid cost factor parses to the correct integer
  // Validates: Requirements 1.1, 2.1, 4.1
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

  // Feature: bcrypt-cost-config, Property 2: out-of-range values are rejected
  // Validates: Requirements 1.2, 1.3, 5.1, 5.2
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

  // Feature: bcrypt-cost-config, Property 3: non-numeric strings are rejected
  // Validates: Requirements 1.4, 5.3
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
