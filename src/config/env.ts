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
    DB_POOL_MAX: z.coerce.number().default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().default(30_000),
    DB_CONN_TIMEOUT_MS: z.coerce.number().default(2_000),

    /**
     * REPLICA_URLS — optional comma-separated list of PostgreSQL read-replica
     * connection strings.
     *
     * Format:
     *   REPLICA_URLS=postgresql://user:pass@replica1:5432/db,postgresql://user:pass@replica2:5432/db
     *
     * Behaviour:
     *   - When set, read-only repository queries are routed round-robin to the
     *     listed replicas. Write queries always use DATABASE_URL (primary).
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
          if (!val || val.trim() === '') return true;
          // Validate that each entry is a parseable postgresql:// URL
          return val.split(',').every((raw) => {
            const url = raw.trim();
            if (!url) return false;
            try {
              const parsed = new URL(url);
              return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
            } catch {
              return false;
            }
          });
        },
        {
          message:
            'REPLICA_URLS must be a comma-separated list of valid postgresql:// or postgres:// connection strings.',
        },
      ),

    // Database (individual fields for health checks)
    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.coerce.number().default(5432),
    DB_USER: z.string().default("postgres"),
    DB_PASSWORD: z.string().default("postgres"),
    DB_NAME: z.string().default("callora"),

    // Auth
    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
    ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),
    METRICS_API_KEY: z.string().min(1, "METRICS_API_KEY is required"),

    // Proxy / Gateway
    UPSTREAM_URL: z.string().url().default("http://localhost:4000"),
    UPSTREAM_HOST_ALLOWLIST: z.string().optional(),
    PROXY_TIMEOUT_MS: z.coerce.number().default(30_000),
    PROXY_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    PROXY_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
    PROXY_BREAKER_SUCCESS_THRESHOLD: z.coerce.number().int().positive().default(1),
    REST_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    REST_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
    WEBHOOK_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().optional(),
    WEBHOOK_SECRET_ROTATION_GRACE_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
    // Generic rate limiter (optional legacy config)
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().optional(),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
    RATE_LIMIT_STORE: z.string().optional(),
    RATE_LIMIT_PG_TABLE: z.string().optional(),

    // CORS
    CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),

    // Soroban RPC (optional)
    SOROBAN_RPC_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),
    SOROBAN_RPC_URL: z.string().url().optional(),
    SOROBAN_RPC_TIMEOUT: z.coerce.number().default(2_000),

    // Horizon (optional)
    HORIZON_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),
    HORIZON_URL: z.string().url().optional(),
    HORIZON_TIMEOUT: z.coerce.number().default(2_000),
    SETTLEMENT_STATUS_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    SETTLEMENT_STATUS_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    SETTLEMENT_RECON_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
    REVENUE_LEDGER_INDEXER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    REVENUE_LEDGER_INDEXER_BATCH_SIZE: z.coerce.number().int().positive().default(500),

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
    TRANSACTION_TIMEOUT: z.coerce.number().int().positive().optional(),

    // Health check
    HEALTH_CHECK_DB_TIMEOUT: z.coerce.number().default(2_000),
    APIS_CACHE_TTL_MS: z.coerce.number().int().positive().optional(),
    LISTINGS_CACHE_WARMUP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    APP_VERSION: z.string().default("1.0.0"),

    // Logging
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
    ACCESS_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
    ACCESS_LOG_REDACT_FIELDS: z.string().optional(),

    // Profiling
    GATEWAY_PROFILING_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),
    // Test-only chaos harness
    SOROBAN_CHAOS: z
      .string()
      .transform((v) => v === "1")
      .default(false),

    // Body size limits
    REQUEST_BODY_LIMIT: z.string().default('100kb'),
    GATEWAY_BODY_LIMIT: z.string().default('1mb'),

    // Security
    BCRYPT_COST_FACTOR: z.coerce.number().int().min(10).max(31).default(12),

    // Billing concurrency control
    BILLING_MAX_CONCURRENCY_PER_DEV: z.coerce.number().int().positive().default(1),
    BILLING_SEMAPHORE_TTL_MS: z.coerce.number().int().positive().default(300000),

    // Idempotency
    IDEMPOTENCY_RETENTION_WINDOW_SECONDS: z.coerce.number().int().positive().default(86400),
    IDEMPOTENCY_SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  })
  .superRefine((values, ctx) => {
    if (values.SOROBAN_RPC_ENABLED && !values.SOROBAN_RPC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_RPC_URL"],
        message: "SOROBAN_RPC_URL is required when SOROBAN_RPC_ENABLED=true",
      });
    }

    if (values.HORIZON_ENABLED && !values.HORIZON_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HORIZON_URL"],
        message: "HORIZON_URL is required when HORIZON_ENABLED=true",
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  parsed.error.issues.forEach((issue) => {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
