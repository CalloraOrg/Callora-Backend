import { envSchema } from "./env.js";

describe("DEMO_MODE configuration", () => {
  const required = { JWT_SECRET: "dummy-jwt", ADMIN_API_KEY: "dummy-admin", METRICS_API_KEY: "dummy-metrics" };
  test.each([[undefined, false], ["false", false], ["true", true]])("parses %s as %s", (value, expected) => {
    expect(envSchema.parse({ ...required, DEMO_MODE: value }).DEMO_MODE).toBe(expected);
  });
  test.each(["yes", "1", "TRUE", "", true])("rejects an ambiguous value: %s", (value) => {
    expect(envSchema.safeParse({ ...required, DEMO_MODE: value }).success).toBe(false);
  });
  test("does not require a billing contract for a production demo", () => {
    const production = {
      ...required,
      NODE_ENV: "production",
      UPSTREAM_HOST_ALLOWLIST: "localhost",
      STELLAR_NETWORK: "testnet",
      ALLOW_TESTNET_IN_PRODUCTION: "true",
    };
    expect(envSchema.safeParse({ ...production, DEMO_MODE: "true" }).success).toBe(true);
    expect(envSchema.safeParse({ ...production, DEMO_MODE: "false" }).success).toBe(false);
  });

  test.each(["true", "false"])("preserves production security checks with DEMO_MODE=%s", (demoMode) => {
    const result = envSchema.safeParse({
      ...required,
      NODE_ENV: "production",
      DEMO_MODE: demoMode,
      STELLAR_NETWORK: "testnet",
      FORWARDED_IDENTITY_ALLOW_LEGACY: "true",
      SOROBAN_BILLING_CONTRACT_ID: "invalid-contract",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining([
          "UPSTREAM_HOST_ALLOWLIST",
          "STELLAR_NETWORK",
          "FORWARDED_IDENTITY_ALLOW_LEGACY",
          "SOROBAN_BILLING_CONTRACT_ID",
        ]),
      );
    }
  });
});
