import "dotenv/config";
import { z } from "zod";

/**
 * Utility to mask sensitive values in logs
 */
const mask = (value: string) => `${value.slice(0, 2)}****${value.slice(-2)}`;

/**
 * Environment schema
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .default(
      "postgresql://postgres:postgres@localhost:5432/callora?schema=public",
    ),

  JWT_SECRET: z
    .string()
    .min(10, "JWT_SECRET must be at least 10 characters")
    .optional(),

  METRICS_API_KEY: z.string().optional(),

  DB_POOL_MAX: z.coerce.number().default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  DB_CONN_TIMEOUT_MS: z.coerce.number().default(2000),

  // Stellar / blockchain related
  SOROBAN_RPC_URL: z.string().url().optional(),
  HORIZON_URL: z.string().url().optional(),
});

/**
 * Parse and validate env
 */
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");

  for (const issue of parsed.error.issues) {
    console.error(`- ${issue.path.join(".")}: ${issue.message}`);
  }

  process.exit(1); // Fail fast
}

const env = parsed.data;

/**
 * Additional runtime validation (context-aware)
 */
if (env.NODE_ENV === "production") {
  if (!env.JWT_SECRET) {
    console.error("❌ JWT_SECRET is required in production");
    process.exit(1);
  }

  if (!env.SOROBAN_RPC_URL) {
    console.error("❌ SOROBAN_RPC_URL is required in production");
    process.exit(1);
  }

  if (!env.HORIZON_URL) {
    console.error("❌ HORIZON_URL is required in production");
    process.exit(1);
  }
}

/**
 * Final typed config object
 */
export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,

  databaseUrl: env.DATABASE_URL,

  dbPool: {
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONN_TIMEOUT_MS,
  },

  jwt: {
    secret: env.JWT_SECRET ?? "dev-secret-change-me",
  },

  metrics: {
    apiKey: env.METRICS_API_KEY,
  },

  stellar: {
    sorobanRpcUrl: env.SOROBAN_RPC_URL,
    horizonUrl: env.HORIZON_URL,
  },
};

/**
 * Log safe config summary (no secrets!)
 */
if (env.NODE_ENV !== "test") {
  console.log("✅ Config loaded:");
  console.log({
    nodeEnv: config.nodeEnv,
    port: config.port,
    databaseUrl: config.databaseUrl,
    jwtSecret: config.jwt.secret ? mask(config.jwt.secret) : undefined,
    metricsEnabled: Boolean(config.metrics.apiKey),
  });
}
