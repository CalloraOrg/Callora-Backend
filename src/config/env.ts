import "dotenv/config";
import { z } from "zod";

const stellarNetworkSchema = z.enum(["testnet", "mainnet"]);

export const envSchema = z
  .object({
    // Server
    PORT: z.coerce.number.default(3000),
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
    DB_POOL_MAX: z.coerce.number.default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number.default(30_000),
    DB_CONN_TIMEOUT_MS: z.coerce.number.default(2_000),

    /**
     * REPLICA_URLS — optional comma-separated list of PostgreSQL read-replica
     * connection strings.
     *
     * Format:
     *   REPLICA_URLS=postgresql://user:pass@replica1:5432/db,,postgresql://user:pass@replica2:5432/db
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
    DB2_HOST: z.string().default("localhost"),
    DB2_HOST: z.string().default("localhost"),
    DB2_PORT: z.coerce.number.default(5432),
    DB_PORT: z.coerce.number.default(5432),
    DB2_USER: z.string().default("postgres"),
    DB_USER: z.string().default("postgres"),
    DB_PASSWORD: z.string().default("postgres"),
    DB2_NAME: z.string().default("callora"),

    // Auth
    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
    ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),
    METRICS_API_KEY: z.string().min(1, "METRICS_API_KEY is required"),
    TRUST_FORWARDED_USER_ID: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
    FORWARDED_USER_ID_SECRET: z.string().optional(),
    INTERNAL_GATEWAY_SECRET: z.string().optional(),

    // Proxy / Gateway
    //
    // TRUST_PROXY_HOPS — number of trusted reverse-proxy hops in front of the
    // app. When > 0, the client IP is taken from the X-Forwarded-For header
    // that many positions from the right (Express 'trust proxy' semantics);
    // the leftmost entries are client-controlled and never trusted. When 0
    // (default), the socket address is used.
    TRUST_PROXY_HOT: z.coerce.number.int().min(0).default(0),
    TRUST_PROXY_HOPS: z.coerce.number.int().min(0).default(0),
    UPSTREAM_URL: z.string().url().default("http://localhost:4000"),
    UPSTREAM_HOST_ALLOWLIST: z.string().optional(),
    PROXY_TIMEOUT_MS: z.coerce.number.default(30_000),
    PROXY_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    PROXY_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
    PROXY_BREAKER_SUCCESS_THRESHOLD: z.coerce.number.int().positive().default(1),
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
    SOROBAN_RPC_TIMEOUT: z.coerce.number.default(2_000),

    // Billing RPC (the contract must be configured in production)
    SOROBAN_BILLING_RPC_URL: z.string().url().optional(),
    SOROBAN_BILLING_CONTRACT_ID: z.string().trim().min(1).optional(),
    SOROBAN_BILLING_SOURCE_ACCOUNT: z.string().min(1).optional(),
    SOROBAN_BILLING_NETWORK_PASSPHRASE: z.string().min(1).optional(),
    SOROBAN_BILLING_BACKEND_SECRET_KEY: z.string().min(1).optional(),
    SOROBAN_BILLING_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    SOROBAN_BILLING_BALANCE_FN: z.string().min(1).default("balance"),
    SOROBAN_BILLING_DEDUCT_FN: z.string().min(1).default("deduct"),

    // Horizon (optional)
    HORIZON_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),
    HORIZON_URL: z.string().url().optional(),
    HORIZON_TIMEOUT: z.coerce.number.default(2_000),
    SETTLEMENT_STATUS_SYNC_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    SETTLEMENT_STATUS_SYNC_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    SETTLEMENT_RECON_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(86_400_000),
    REVENUE_LEDGER_INDEXER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000),
    REVENUE_LEDGER_INDEXER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(500),

    // Stellar network configuration
    STELLAR_NETWORK: stellarNetworkSchema.optional(),
    SOROBAN_NETWORK: stellarNetworkSchema.optional(),

    STELLAR_TESTNET_HORIZON_URL: z
      .string()
      .url()
      .default("https://horizon-testnet.stellar.org"),
    STELLAR_MAINNET_HORIZON_URL: z
      .string()
      .url()
      .default("https://horizon.stellar.org"),
    SOROBAN_TESTNET_RPC_URL: z
      .string()
      .url()
      .default("https://soroban-testnet.stellar.org"),
    SOROBAN_MAINNET_RPC_URL: z
      .string()
      .url()
      .default("https://soroban-mainnet.stellar.org"),

    STELLAR_TESTNET_VAULT_CONTRACT_ID: z.string().min(1).optional(),
    STELLAR_MAINNET_VAULT_CONTRACT_ID: z.string().min(1).optional(),
    STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID: z.string().min(1).optional(),
    STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID: z.string().min(1).optional(),

    STELLAR_BASE_FEE: z.coerce.number().int().positive().default(100),
    STELLAR_TRANSACTION_TIMEOUT: z.coerce.number().int().positive().optional(),
    TRANSACT
  });
