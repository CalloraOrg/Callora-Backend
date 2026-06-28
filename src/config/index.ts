import { env } from "./env.js";
import {
  parseUpstreamHostAllowlist,
  validateUpstreamBaseUrl,
} from "../lib/upstreamTarget.js";

export type StellarNetwork = "testnet" | "mainnet";

interface StellarNetworkConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  vaultContractId?: string;
  settlementContractId?: string;
}

const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_NETWORK_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

function isLocalStellarHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function validateStellarEndpointUrl(name: string, rawUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalStellarHost(parsed.hostname))) {
    throw new Error(
      `${name} must use HTTPS unless it targets localhost for local development.`
    );
  }

  if (!parsed.hostname) {
    throw new Error(`${name} must include a hostname.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not include embedded credentials.`);
  }

  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must not include query strings or fragments.`);
  }

  return parsed.toString();
}

const selectedNetwork: StellarNetwork =
  env.STELLAR_NETWORK ?? env.SOROBAN_NETWORK ?? "testnet";

const testnetConfig: StellarNetworkConfig = {
  horizonUrl: validateStellarEndpointUrl(
    "STELLAR_TESTNET_HORIZON_URL",
    env.STELLAR_TESTNET_HORIZON_URL
  ),
  sorobanRpcUrl: validateStellarEndpointUrl(
    "SOROBAN_TESTNET_RPC_URL",
    env.SOROBAN_TESTNET_RPC_URL
  ),
  networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  vaultContractId: env.STELLAR_TESTNET_VAULT_CONTRACT_ID,
  settlementContractId: env.STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID,
};

const mainnetConfig: StellarNetworkConfig = {
  horizonUrl: validateStellarEndpointUrl(
    "STELLAR_MAINNET_HORIZON_URL",
    env.STELLAR_MAINNET_HORIZON_URL
  ),
  sorobanRpcUrl: validateStellarEndpointUrl(
    "SOROBAN_MAINNET_RPC_URL",
    env.SOROBAN_MAINNET_RPC_URL
  ),
  networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
  vaultContractId: env.STELLAR_MAINNET_VAULT_CONTRACT_ID,
  settlementContractId: env.STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID,
};

const activeConfig =
  selectedNetwork === "mainnet" ? mainnetConfig : testnetConfig;

const upstreamHostAllowlist = parseUpstreamHostAllowlist(env.UPSTREAM_HOST_ALLOWLIST);
const validatedUpstreamUrl = validateUpstreamBaseUrl(env.UPSTREAM_URL, {
  allowedHosts: upstreamHostAllowlist,
});

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  version: env.APP_VERSION,
  accessLog: {
    sampleRate: env.ACCESS_LOG_SAMPLE_RATE,
    redactFields: (env.ACCESS_LOG_REDACT_FIELDS ?? '')
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field.length > 0),
  },

  databaseUrl: env.DATABASE_URL,
  replicaUrls: env.REPLICA_URLS,
  database: {
    pool: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_CONN_TIMEOUT_MS,
    },
    timeout: env.HEALTH_CHECK_DB_TIMEOUT,
  },
  dbPool: {
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONN_TIMEOUT_MS,
  },
  jwt: {
    secret: env.JWT_SECRET,
  },
  metrics: {
    apiKey: env.METRICS_API_KEY,
  },

  proxy: {
    upstreamUrl: validatedUpstreamUrl,
    timeoutMs: env.PROXY_TIMEOUT_MS,
    allowedHosts: upstreamHostAllowlist,
  },

  restRateLimit: {
    windowMs: env.REST_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.REST_RATE_LIMIT_MAX_REQUESTS,
  },

  webhookRateLimit: {
    windowMs: env.WEBHOOK_RATE_LIMIT_WINDOW_MS ?? env.REST_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.WEBHOOK_RATE_LIMIT_MAX_REQUESTS ?? env.REST_RATE_LIMIT_MAX_REQUESTS,
  },

  webhooks: {
    secretRotationGraceMs: env.WEBHOOK_SECRET_ROTATION_GRACE_MS,
  },

  loginRateLimit: {
    windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.LOGIN_RATE_LIMIT_MAX_REQUESTS,
  },

  rateLimiter: {
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    store: env.RATE_LIMIT_STORE,
    postgresTable: env.RATE_LIMIT_PG_TABLE,
  },

  sorobanRpc:
    env.SOROBAN_RPC_ENABLED && env.SOROBAN_RPC_URL
      ? {
          url: env.SOROBAN_RPC_URL,
          timeout: env.SOROBAN_RPC_TIMEOUT,
        }
      : undefined,

  horizon:
    env.HORIZON_ENABLED && env.HORIZON_URL
      ? {
          url: env.HORIZON_URL,
          timeout: env.HORIZON_TIMEOUT,
        }
      : undefined,

  settlementSync: {
    intervalMs: env.SETTLEMENT_STATUS_SYNC_INTERVAL_MS,
    timeoutMs: env.SETTLEMENT_STATUS_SYNC_TIMEOUT_MS,
  },
  settlementRecon: {
    intervalMs: env.SETTLEMENT_RECON_INTERVAL_MS,
  },
  revenueLedgerIndexer: {
    intervalMs: env.REVENUE_LEDGER_INDEXER_INTERVAL_MS,
    batchSize: env.REVENUE_LEDGER_INDEXER_BATCH_SIZE,
  },

  stellar: {
    network: selectedNetwork,
    baseFee: String(env.STELLAR_BASE_FEE),
    transactionTimeout:
      env.STELLAR_TRANSACTION_TIMEOUT ?? env.TRANSACTION_TIMEOUT ?? 300,
    networkPassphrase: activeConfig.networkPassphrase,
    horizonUrl: activeConfig.horizonUrl,
    sorobanRpcUrl: activeConfig.sorobanRpcUrl,
    vaultContractId: activeConfig.vaultContractId,
    settlementContractId: activeConfig.settlementContractId,
    networks: {
      testnet: testnetConfig,
      mainnet: mainnetConfig,
    },
  },

  bcrypt: {
    costFactor: env.BCRYPT_COST_FACTOR,
  },
  billingConcurrency: {
    maxPerDeveloper: env.BILLING_MAX_CONCURRENCY_PER_DEV,
    semaphoreTtlMs: env.BILLING_SEMAPHORE_TTL_MS,
  },
  idempotency: {
    retentionWindowSeconds: env.IDEMPOTENCY_RETENTION_WINDOW_SECONDS,
    sweeperIntervalMs: env.IDEMPOTENCY_SWEEPER_INTERVAL_MS,
  },
  listingsCache: {
    warmupTimeoutMs: env.LISTINGS_CACHE_WARMUP_TIMEOUT_MS,
  },
  bulkEndpointLimit: env.BULK_ENDPOINT_LIMIT,

  memoryAccounting: {
    enabled: env.MEMORY_ACCOUNTING_ENABLED,
    thresholdMb: env.MEMORY_ACCOUNTING_THRESHOLD_MB,
  },
} as const;
