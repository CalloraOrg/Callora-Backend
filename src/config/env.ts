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
    PROXY_BREAKER_FAILURE_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    PROXY_BREAKER_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000),
    PROXY_BREAKER_SUCCESS_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
    REST_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    REST_RATE_LIMIT_MAX_REQUESTS: z.coerce
      .number()
      .int()
      .positive()
      .default(100),
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
    TRANSACTION_TIMEOUT: z.coerce.number().int().positive().optional(),

    // Health check
    HEALTH_CHECK_DB_TIMEOUT: z.coerce.number().default(2_000),
    APIS_CACHE_TTL_MS: z.coerce.number().int().positive().optional(),
    LISTINGS_CACHE_WARMUP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    REFUNDS_CACHE_WARMUP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),
    BULK_ENDPOINT_LIMIT: z.coerce.number().int().positive().default(100),
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

    // Memory accounting
    MEMORY_ACCOUNTING_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),
    MEMORY_ACCOUNTING_THRESHOLD_MB: z.coerce.number().nonnegative().default(50),
    // Test-only chaos harness
    SOROBAN_CHAOS: z
      .string()
      .transform((v) => v === "1")
      .default(false),

    // Body size limits
    REQUEST_BODY_LIMIT: z.string().default("100kb"),
    GATEWAY_BODY_LIMIT: z.string().default("1mb"),
    ROUTE_BODY_LIMITS: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value || value.trim().length === 0) {
          return [];
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `ROUTE_BODY_LIMITS must be valid JSON: ${(error as Error).message}`,
          });
          return z.NEVER;
        }

        if (!Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "ROUTE_BODY_LIMITS must be a JSON array of route body-limit objects",
          });
          return z.NEVER;
        }

        return parsed.filter(
          (entry): entry is Record<string, unknown> =>
            !!entry && typeof entry === "object",
        );
      })
      .pipe(
        z.array(
          z.object({
            method: z.string().min(1),
            route: z.string().min(1),
            limit: z.string().min(1),
          }),
        ),
      )
      .default([]),

    // Security
    BCRYPT_COST_FACTOR: z.coerce.number().int().min(10).max(31).default(12),

    // Billing concurrency control
    BILLING_MAX_CONCURRENCY_PER_DEV: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
    BILLING_SEMAPHORE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300000),

    // Gateway per-API-key concurrency control.
    // The default ceiling is deliberately generous: the primary purpose is
    // observability via GET /api/admin/keys/concurrency. Operators opt into
    // enforcement by lowering KEY_MAX_CONCURRENCY_PER_KEY.
    KEY_MAX_CONCURRENCY_PER_KEY: z.coerce.number().int().positive().default(50),
    KEY_SEMAPHORE_TTL_MS: z.coerce.number().int().positive().default(300000),

    // Idempotency
    IDEMPOTENCY_RETENTION_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(86400),
    IDEMPOTENCY_SWEEPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),

    // Slow query alerting
    SLOW_QUERY_ALERT_WEBHOOK_URL: z.string().url().optional(),
    SLOW_QUERY_P95_THRESHOLD_MS: z.coerce.number().positive().default(500),
    SLOW_QUERY_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    SLOW_QUERY_DEDUP_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(3600),

    // Usage anomaly detector (5-minute rolling baseline)
    USAGE_ANOMALY_DETECTOR_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    USAGE_ANOMALY_MULTIPLIER: z.coerce.number().positive().default(5),
    USAGE_ANOMALY_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    USAGE_ANOMALY_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    USAGE_ANOMALY_BASELINE_WINDOWS: z.coerce
      .number()
      .int()
      .positive()
      .default(12),
    USAGE_ANOMALY_DEDUP_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .optional(),

    // Monthly invoice job
    MONTHLY_INVOICE_JOB_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(86400000),

    // ────────────────────────────────────────────────────────────────────────
    // SLO burn-rate alerting (issue #706)
    //
    // Each entry in `SLO_ROUTE_CONFIGS` defines a per-route burn threshold
    // evaluated against a rolling 96-hour window by the SLO alerter worker.
    // At least one of `maxErrorRate` or `maxLatencyP95Ms` must be set, and
    // `method`/`route` must match the parameterised Express route label
    // emitted by `http_request_duration_seconds` (e.g. `/api/billing/deduct`
    // or `/v1/call/:apiId`).
    //
    // Implementation note: the env variable is a JSON string but the schema
    // resolves to a typed `SloRouteConfig[]`. The `transform` clause parses
    // and validates the JSON before the `pipe(z.array(...))` step enforces
    // per-entry shape (and the `refine` rejects entries missing either
    // threshold). Map to `[]` when the env var is unset or empty — there is
    // no need to also call `.default()` here because the transform already
    // covers the `undefined` case.
    // ────────────────────────────────────────────────────────────────────────
    SLO_ROUTE_CONFIGS: z
      .string()
      .optional()
      .transform((val, ctx) => {
        if (!val || val.trim().length === 0) {
          return [];
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(val);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `SLO_ROUTE_CONFIGS must be valid JSON: ${(err as Error).message}`,
          });
          return z.NEVER;
        }
        if (!Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "SLO_ROUTE_CONFIGS must be a JSON array of route objects",
          });
          return z.NEVER;
        }
        return parsed as Array<unknown>;
      })
      .pipe(
        z.array(
          z
            .object({
              method: z.string().min(1, "method is required"),
              route: z
                .string()
                .min(1, "route is required")
                .startsWith("/", 'route must start with "/"'),
              maxErrorRate: z.number().min(0).max(1).optional(),
              maxLatencyP95Ms: z.number().positive().optional(),
            })
            .refine(
              (cfg) =>
                cfg.maxErrorRate !== undefined ||
                cfg.maxLatencyP95Ms !== undefined,
              "each SLO route config must define at least one of maxErrorRate or maxLatencyP95Ms",
            ),
        ),
      ),
    SLO_ALERT_WEBHOOK_URL: z.string().url().optional(),
    SLO_ALERT_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),
    SLO_ALERT_DEDUP_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(86_400_000), // 24h
    SLO_ALERT_OBSERVATION_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(345_600_000), // 96h = 4 days, the slow-burn window
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
