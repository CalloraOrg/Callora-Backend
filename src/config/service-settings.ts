import { env } from "./env.js";
import { activeConfig, mainnetConfig, selectedNetwork, testnetConfig, billingNetworkPassphrase, billingRpcUrl, billingContractId } from "./stellar.js";

export const serviceSettings = {
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
  billing: {
    networkPassphrase: billingNetworkPassphrase,
    rpcUrl: billingRpcUrl,
    contractId: billingContractId,
  },
  vaultSnapshotMaxAgeMs: env.VAULT_SNAPSHOT_MAX_AGE_MS,

  bcrypt: {
    // Number of bcrypt hashing rounds (BCRYPT_COST_FACTOR, defaults to 12).
    rounds: env.BCRYPT_COST_FACTOR,
  },
  billingTimeoutMs: Number(process.env.BILLING_TIMEOUT_MS ?? 5000),

  billingConcurrency: {
    maxPerDeveloper: env.BILLING_MAX_CONCURRENCY_PER_DEV,
    semaphoreTtlMs: env.BILLING_SEMAPHORE_TTL_MS,
  },
  keyConcurrency: {
    maxPerKey: env.KEY_MAX_CONCURRENCY_PER_KEY,
    semaphoreTtlMs: env.KEY_SEMAPHORE_TTL_MS,
  },
  routeBodyLimits: env.ROUTE_BODY_LIMITS,
  idempotency: {
    leaseSeconds: env.IDEMPOTENCY_LEASE_SECONDS,
    retentionWindowSeconds: env.IDEMPOTENCY_RETENTION_WINDOW_SECONDS,
    sweeperIntervalMs: env.IDEMPOTENCY_SWEEPER_INTERVAL_MS,
    maxBodyBytes: env.IDEMPOTENCY_MAX_BODY_BYTES,
  },
  listingsCache: {
    warmupTimeoutMs: env.LISTINGS_CACHE_WARMUP_TIMEOUT_MS,
  },
  refundsCache: {
    warmupTimeoutMs: env.REFUNDS_CACHE_WARMUP_TIMEOUT_MS,
  },
  bulkEndpointLimit: env.BULK_ENDPOINT_LIMIT,

  slowQueryAlerter: {
    webhookUrl: env.SLOW_QUERY_ALERT_WEBHOOK_URL,
    p95ThresholdMs: env.SLOW_QUERY_P95_THRESHOLD_MS,
    pollIntervalMs: env.SLOW_QUERY_POLL_INTERVAL_MS,
    dedupWindowMs: env.SLOW_QUERY_DEDUP_WINDOW_SECONDS * 1000,
  },

  memoryAccounting: {
    enabled: env.MEMORY_ACCOUNTING_ENABLED,
    thresholdMb: env.MEMORY_ACCOUNTING_THRESHOLD_MB,
  },

  usageAnomalyDetector: {
    enabled: env.USAGE_ANOMALY_DETECTOR_ENABLED,
    multiplier: env.USAGE_ANOMALY_MULTIPLIER,
    pollIntervalMs: env.USAGE_ANOMALY_POLL_INTERVAL_MS,
    windowMs: env.USAGE_ANOMALY_WINDOW_MS,
    baselineWindows: env.USAGE_ANOMALY_BASELINE_WINDOWS,
    dedupWindowMs:
      env.USAGE_ANOMALY_DEDUP_WINDOW_MS ?? env.USAGE_ANOMALY_WINDOW_MS,
  },

  monthlyInvoiceJob: {
    intervalMs: env.MONTHLY_INVOICE_JOB_INTERVAL_MS,
  },

  idempotencySweeper: {
    enabled: env.IDEMPOTENCY_SWEEPER_ENABLED,
    intervalMs: env.IDEMPOTENCY_SWEEPER_INTERVAL_MS,
    batchSize: env.IDEMPOTENCY_SWEEPER_BATCH_SIZE,
    timeBudgetMs: env.IDEMPOTENCY_SWEEPER_TIME_BUDGET_MS,
  },

  sloAlert: {
    enabled:
      Boolean(env.SLO_ALERT_WEBHOOK_URL) && env.SLO_ROUTE_CONFIGS.length > 0,
    webhookUrl: env.SLO_ALERT_WEBHOOK_URL,
    pollIntervalMs: env.SLO_ALERT_POLL_INTERVAL_MS,
    dedupWindowMs: env.SLO_ALERT_DEDUP_WINDOW_MS,
    observationWindowMs: env.SLO_ALERT_OBSERVATION_WINDOW_MS,
    configs: env.SLO_ROUTE_CONFIGS as Array<{
      method: string;
      route: string;
      maxErrorRate?: number;
      maxLatencyP95Ms?: number;
    }>,
  },
} as const;
