import { z } from "zod";
import { contractId, publicKey, secretKey } from "./stellar-env-keys.js";
const stellarNetworkSchema = z.enum(["testnet", "mainnet"]);

export const integrationEnvironmentFields = {
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
  SOROBAN_BILLING_CONTRACT_ID: contractId.optional(),
  SOROBAN_BILLING_SOURCE_ACCOUNT: publicKey.optional(),
  SOROBAN_BILLING_NETWORK_PASSPHRASE: z.string().min(1).optional(),
  SOROBAN_BILLING_BACKEND_SECRET_KEY: secretKey.optional(),
  SOROBAN_BILLING_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  SOROBAN_BILLING_NETWORK: stellarNetworkSchema.default("testnet"),

  // Stellar accounts / contracts
  STELLAR_FEE_ACCOUNT_SECRET_KEY: z.string().min(1).optional(),
  STELLAR_FEE_ACCOUNT_PUBLIC_KEY: z.string().min(1).optional(),
  SOROBAN_BILLING_BALANCE_FN: z.string().min(1).default("balance"),
  SOROBAN_BILLING_DEDUCT_FN: z.string().min(1).default("deduct"),

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
  SETTLEMENT_MAX_RETRIES: z.coerce.number().int().positive().default(5),
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

  STELLAR_TESTNET_VAULT_CONTRACT_ID: contractId.optional(),
  STELLAR_MAINNET_VAULT_CONTRACT_ID: contractId.optional(),
  STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID: contractId.optional(),
  STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID: contractId.optional(),
  VAULT_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().positive().default(60_000),

  STELLAR_BASE_FEE: z.coerce.number().int().positive().default(100),
  STELLAR_TRANSACTION_TIMEOUT: z.coerce.number().int().positive().optional(),
  TRANSACTION_TIMEOUT: z.coerce.number().int().positive().optional(),

  // Health check
  HEALTH_CHECK_DB_TIMEOUT: z.coerce.number().default(2_000),
  /**
   * HEALTH_REQUEST_TIMEOUT_MS — maximum wall-clock time (ms) allowed for a
   * full GET /api/health response. When the deadline is exceeded the request
   * is cooperatively aborted and the caller receives HTTP 504.
   * Default: 5 000 ms.
   */
  HEALTH_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
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
  USAGE_ACCESS_LOG_REDACT_FIELDS: z.string().optional(),

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
  // Both values must be positive integers; the superRefine in env.ts rejects
  // zero so the bigint division in the quote service can never divide by
  // zero at runtime.
  FEE_ABSTRACTION_RATE_NUMERATOR: z.coerce.number().int().positive().default(1),
  FEE_ABSTRACTION_RATE_DENOMINATOR: z.coerce.number().int().positive().default(10),
  // Lifetime of a persisted quote. Expired quotes cannot be consumed;
  // execution returns 409.
  FEE_ABSTRACTION_QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
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
  FEE_ABSTRACTION_PAYMENT_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
} as const;
