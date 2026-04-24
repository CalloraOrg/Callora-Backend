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
    PROXY_TIMEOUT_MS: z.coerce.number().default(30_000),

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
    APP_VERSION: z.string().default("1.0.0"),

    // Logging
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),

    // Profiling
    GATEWAY_PROFILING_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default(false),

    // Body size limits
    REQUEST_BODY_LIMIT: z.string().default('100kb'),
    GATEWAY_BODY_LIMIT: z.string().default('1mb'),
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
