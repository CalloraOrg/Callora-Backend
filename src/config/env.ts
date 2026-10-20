import "dotenv/config";
import { z } from "zod";

const stellarNetworkSchema = z.enum(["testnet", "mainnet"]);

export const envSchema = z
  .object({
    // Server
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),

    // Database (primary connection string)
    DATABASE_URL: z
      .string()
      .default(
        "postgresql://postgres:postgres@localhost:5432/callora?schema=public",
      ),

    // Database pool
    DB2_POOL_MAX: z.coerce.number().default(10),
    DB_IDlE_TIMEOUT_MS: z.coerce.number().default(30_000),
    DB2_CONN_TIMEOUT_MS: z.coerce.number().default(2_000),

    /**
     * REPLICA_URLS — optional comma-separated list of PostgreSQL read-replica
     * connection strings.
     *
     * Format:
     *   REPLICA_URLS=postgresql://user:pass@replica1:5432/db,postgresql://user:pass@replica2:5432/db
     *
     * Behaviour:
     *   - When set, read-only repository queries are routed round-robin to
     *     the listed replicas. Write queries always use DATABASE_URL (primary).
     *   - On replica failure the query is automatically retried against the
     *     primary; see src/db/replicaPool.ts for details.
     *   - When absent or empty, all queries continue to use the primary pool.
     *
     * Each URL must use the postgresql:// or postgres:// scheme. Individual
     * URL validation (scheme, format) is performed at application startup by
     * the replica pool initialisation code in src/db/replicaPool.ts.
     */
    REPLICA_URLS: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (!val || val.trim() === "") return true;
          // Validate that each entry is a parseable postgresql:// URL
          return val.split(",").every((raw) => {
            const url = raw.trim();
            if (!url) return false;
            try {
              const parsed = new URL(url);
              return (
                parsed.protocol === "postgresql:" ||
                parsed.protocol === "postgres:"
              );
            } catch {
              return false;
            }
          });
        },
        {
          message:
            "REPLICA_URLS must be a comma-separated list of valid postgresql:// or postgres:// connection strings.",
        },
      ),

    // Database (individual fields for health checks)
    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.coerce.number().default(5432),
    DB2_USER: z.string().default("postgres"),
    DB_PASSWORD: z.string().default("postgres"),
    DB_NAME: z.string().default("callora"),

    // Auth
    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
    ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),
    METRICS_API_KEY: z.string().min(1, "METRICS_API_KEY is required"),
    TRUST_FORWARDED_USER_ID: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
    FORWARDED_IDENTITY_TOLERANCE_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    FORWARDED_IDENTITY_ALLOW_LEGACY: z.string().optional().transform(v => v === "true").default(false),
    FORWARDED_IDENTITY_REPLAY_STORE: z.enum(["memory", "postgres"]).default("memory"),
    FORWARDED_IDENTITY_REPLAY_MAX_ENTRIES: z.coerce.number().int().positive().max(1_000_000).default(10_000),
    FORWARDED_USER_ID_SECRET: z.string().optional(),
    INTERNAL_GATEWAY_SECRET: z.string().optional(),

    // Proxy / Gateway
    UPSTREAM_URL: z.string().url().default("http://localhost:4000"),
    UPSTREAM_HOST_ALLOWLIST: z.string().optional(),
    PROXY_TIMEOUT_MS: z.coerce.number().default(30_000),
    PROXY_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    PROXY_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
    PROXY_BREAKER_SUCCESS_THRESHOLD: z.coerce.number().int().positive().default(1),
    // REST API rate limiting (per-user with IP fallback)
    REST_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    REST_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    // Gateway/proxy rate limiting (per authenticated user only)
    GATEWAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    GATEWAY_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
    WEBHOOK_RATE_LIMIT_MAX_REQUESTS: z.coerce
      .number()
      .int()
      .positive()
      .optional(),
    WEBHOOK_SECRET_ROTATION_GRACE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60 * 1000),
    // Per-API-key token-bucket rate limit applied to /api/gateway and /v1/call.
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_STORE: z.enum(["memory", "postgres"]).default("memory"),
    RATE_LIMIT_OUTAGE_MODE: z.enum(["fail-closed", "fallback"]).default("fail-closed"),
    RATE_LIMIT_FALLBACK_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_FALLBACK_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_FALLBACK_MAX_BUCKETS: z.coerce.number().int().positive().default(10_000),
    RATE_LIMIT_PG_TABLE: z
      .string()
      .regex(
        /^[a-z_][a-z0-9_]*$/i,
        "RATE_LIMIT_PG_TABLE must contain only letters, numbers, and underscores",
      )
      .default("gateway_rate_limit_buckets"),

    // Auth per-request timeout (graceful timeout with 504 Gateway Timeout)
    AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    // Login rate limiting (IP-based throttling for auth attempts)
    LOGIN_RATE_LIMIT_MAX_REQUESTS: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000), // 1 minute sliding window

    // Credits endpoint token-bucket rate limiting
    CREDITS_RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(10),
    CREDITS_RATE_LIMIT_REFILL_RATE: z.coerce.number().positive().default(1),

    // /api/quotas per-user token-bucket rate limiting.
    // capacity:    maximum burst of requests before the bucket empties (default 60).
    // refillRate:  tokens added per second (default 1 → steady-state of 1 req/s).
    QUOTA_RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(60),
    QUOTA_RATE_LIMIT_REFILL_RATE: z.coerce.number().positive().default(1),

    // Billing endpoint per-user rate limiting (fixed-window)
    BILLING_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    BILLING_RATE_LIMIT_MAX_REQUESTS: z.coerce
      .number()
      .int()
      .positive()
      .default(100),

    // Fee abstraction (POST /api/billing/fee-abstraction)
    //
    // The fee-bump endpoint signs transactions with the platform fee account,
    // so every fee-bump must be backed by a verified, single-use quote and an
    // on-chain app-token payment. These settings control quote pricing,
    // payment verification and the inner-transaction allowlist.
    //
    // FEE_ABSTRACTION_RATE_* — integer-scaled conversion from stroops to
    // app-token units. The quoted amount is computed as
    //   ceil(feeStroops * FEE_ABSTRACTION_RATE_NUMERATOR / FEE_ABSTRACTION_RATE_DENOMINATOR)
    // using bigint math only (no floats). Defaults to 1 app-token unit per
    // 10 stroops (i.e. 0.10 XLM against the historical rate).
    // Both values must be positive integers; the superRefine below rejects
    // zero so the bigint division in the quote service can never divide by
    // zero at runtime.
    FEE_ABSTRACTION_RATE_NUMERATOR: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
    FEE_ABSTRACTION_RATE_DENOMINATOR: z.coerce
      .number()
      .int()
      .positive()
      .default(10),
    // Lifetime of a signed quote. After this window the quote is expired and
    // execution returns 410.
    FEE_ABSTRACTION_QUOTE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    // Treasury Stellar address that must receive the app-token payment.
    FEE_ABSTRACTION_TREASURY_ADDRESS: z.string().min(1).optional(),
    // App-token issuer/asset used for payment verification.
    FEE_ABSTRACTION_APP_TOKEN_ASSET_CODE: z.string().min(1).default("APP"),
    FEE_ABSTRACTION_APP_TOKEN_ISSUER: z.string().min(1).optional(),
    // Vault contract ids allowed as the target of an inner invokeHostFunction.
    // Comma-separated; when unset the network-specific vault contract id is
    // used (STELLAR_*_VAULT_CONTRACT_ID).
    FEE_ABSTRACTION_VAULT_CONTRACT_IDS: z.string().optional(),
    // Upper bound on the time spent verifying the payment on-chain. Must be
    // less than the route timeout so verification fails closed.
    FEE_ABSTRACTION_PAYMENT_VERIFY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),

    // CORS
    CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),

    // Subscription CORS allowlist (comma-separated origins; deny by default when empty).
    //
    // This entry mirrors the pattern used by MAINTENANCE_CORS_ALLOWED_ORIGINS:
    // the runtime parser lives in
    // {@link createSubscriptionCorsMiddleware} (src/middleware/cors.ts), which
    // reads `process.env` lazily so tests that mutate the env after module
    // load still work. If this entry is transformed into an array here, the
    // middleware will continue to read the raw string and the two sources of
    // truth will silently diverge.
    SUBSCRIPTION_CORS_ALLOWED_ORIGINS: z.string().default(""),

    // Maintenance CORS allowlist (comma-separated origins; deny by default when empty).
    //
    // This entry is intentionally left as a raw string — it exists in the
    // schema for documentation and `.env.example` cross-referencing purposes
    // only. The runtime parser lives in
    // {@link createMaintenanceCorsMiddleware} (src/middleware/cors.ts), which
    // reads `process.env` lazily so tests that mutate the env after module
    // load still work. If this entry is transformed into an array here, the
    // middleware will continue to read the raw string and the two sources of
    // truth will silently diverge.
    MAINTENANCE_CORS_ALLOWED_ORIGINS: z.string().default(""),

    // Apis CORS allowlist (comma-separated origins; deny by default when empty).
    //
    // This entry is intentionally left as a raw string — it exists in the
    // schema for documentation and `.env.example` cross-referencing purposes
    // only. The runtime parser lives in
    // {@link createApisCorsMiddleware} (src/middleware/cors.ts), which
    // reads `process.env` lazily so tests that mutate the env after module
    // load still work. If this entry is transformed into an array here, the
    // middleware will continue to read the raw string and the two sources of
    // truth will silently diverge.
    APIS_CORS_ALLOWED_ORIGINS: z.string().default(""),

    // Soroban RPC (optional)
    SOROBAN_RPC_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),
    SOROBAN_RPC_URL: z.string().url().optional(),
    SOROBAN_RPC_TIMEOUT: z.coerce.number().default(2_000),

    // Billing RPC (the contract must be configured in production)
    SOROBAN_BILLING_RPC_URL: z.string().url().optional(),
    SOROBAN_BILLING_CONTRACT_ID: z.string().trim().min(1).optional(),
    SOROBAN_BILLING_SOURCE_ACCOUNT: z.string().min(1).optional(),
    SOROBAN_BILLING_NETWORK_PASSPHRASE: z.string().min(1).optional(),
    SOROBAN_BILLING_BACKEND_SECRET_KEY: z.string().min(1).optional(),
    SOROBAN_BILLING_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    SOROBAN_BILLING_NETWORK: stellarNetworkSchema.default("testnet"),

    // Stellar accounts / contracts
    STELLAR_TESTNET_HORIZON_URL: z.string().url().optional(),
    STELLAR_MAINNET_HORIZON_URL: z.string().url().optional(),
    STELLAR_TESTNET_VAULT_CONTRACT_ID: z.string().min(1).optional(),
    STELLAR_MAINNET_VAULT_CONTRACT_ID: z.string().min(1).optional(),
    STELLAR_FEE_ACCOUNT_SECRET_KEY: z.string().min(1).optional(),
    STELLAR_FEE_ACCOUNT_PUBLIC_KEY: z.string().min(1).optional(),
  })
  .superRefine((data) => {
    if (data.FEE_ABSTRACTION_RATE_DENOMINATOR === 0) {
      return false;
    }
    return true;
  }, {
    message: "FEE_ABSTRACTION_RATE_DENOMINATOR must be greater than zero",
  });

export type EnvSchema = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
