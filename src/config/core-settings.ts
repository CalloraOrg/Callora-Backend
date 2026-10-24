import { parseUpstreamHostAllowlist, validateUpstreamBaseUrl } from "../lib/upstreamTarget.js";
import { env } from "./env.js";
const upstreamHostAllowlist = parseUpstreamHostAllowlist(env.UPSTREAM_HOST_ALLOWLIST);
const validatedUpstreamUrl = validateUpstreamBaseUrl(env.UPSTREAM_URL, { allowedHosts: upstreamHostAllowlist });

export const coreSettings = {
  port: env.PORT,
  demoMode: env.DEMO_MODE,
  nodeEnv: env.NODE_ENV,
  version: env.APP_VERSION,
  accessLog: {
    sampleRate: env.ACCESS_LOG_SAMPLE_RATE,
    redactFields: (env.ACCESS_LOG_REDACT_FIELDS ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field.length > 0),
  },
  usageAccessLog: {
    redactFields: (env.USAGE_ACCESS_LOG_REDACT_FIELDS ?? "")
      .split(",")
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
  /** Per-request timeout for GET /api/health (ms). Sends 504 on exceed. */
  healthRequestTimeoutMs: env.HEALTH_REQUEST_TIMEOUT_MS,
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

  exports: {
    enabled: env.EXPORTS_ENABLED,
    bucket: env.EXPORTS_S3_BUCKET,
    endpoint: env.EXPORTS_S3_ENDPOINT,
    region: env.EXPORTS_S3_REGION,
    signingSecret: env.EXPORTS_SIGNING_SECRET,
    endpointAllowlist: (env.EXPORTS_S3_ENDPOINT_ALLOWLIST ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
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

  gatewayRateLimit: {
    windowMs: env.GATEWAY_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.GATEWAY_RATE_LIMIT_MAX_REQUESTS,
  },

  webhookRateLimit: {
    windowMs: env.WEBHOOK_RATE_LIMIT_WINDOW_MS ?? env.REST_RATE_LIMIT_WINDOW_MS,
    maxRequests:
      env.WEBHOOK_RATE_LIMIT_MAX_REQUESTS ?? env.REST_RATE_LIMIT_MAX_REQUESTS,
  },

  webhooks: {
    secretRotationGraceMs: env.WEBHOOK_SECRET_ROTATION_GRACE_MS,
  },

  authTimeoutMs: env.AUTH_TIMEOUT_MS,

  loginRateLimit: {
    windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.LOGIN_RATE_LIMIT_MAX_REQUESTS,
  },

  creditsRateLimit: {
    capacity: env.CREDITS_RATE_LIMIT_CAPACITY,
    refillRate: env.CREDITS_RATE_LIMIT_REFILL_RATE,
  },

  billingRateLimit: {
    windowMs: env.BILLING_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.BILLING_RATE_LIMIT_MAX_REQUESTS,
  },

  quotaRateLimit: {
    // Token-bucket parameters for the /api/quotas endpoint group.
    // Burst: up to `capacity` requests are allowed immediately.
    // Steady-state: `refillRate` tokens per second are added back to each bucket.
    capacity: env.QUOTA_RATE_LIMIT_CAPACITY,
    refillRate: env.QUOTA_RATE_LIMIT_REFILL_RATE,
  },

  rateLimiter: {
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    store: env.RATE_LIMIT_STORE,
    postgresTable: env.RATE_LIMIT_PG_TABLE,
    outageMode: env.RATE_LIMIT_OUTAGE_MODE,
    fallbackMaxRequests: env.RATE_LIMIT_FALLBACK_MAX_REQUESTS,
    fallbackWindowMs: env.RATE_LIMIT_FALLBACK_WINDOW_MS,
    maxFallbackBuckets: env.RATE_LIMIT_FALLBACK_MAX_BUCKETS,
  },

  sorobanRpc:
    !env.DEMO_MODE && env.SOROBAN_RPC_ENABLED && env.SOROBAN_RPC_URL
      ? {
          url: env.SOROBAN_RPC_URL,
          timeout: env.SOROBAN_RPC_TIMEOUT,
        }
      : undefined,

  horizon:
    !env.DEMO_MODE && env.HORIZON_ENABLED && env.HORIZON_URL
      ? {
          url: env.HORIZON_URL,
          timeout: env.HORIZON_TIMEOUT,
        }
      : undefined,

  settlementSync: {
    intervalMs: env.SETTLEMENT_STATUS_SYNC_INTERVAL_MS,
    timeoutMs: env.SETTLEMENT_STATUS_SYNC_TIMEOUT_MS,
    maxRetries: env.SETTLEMENT_MAX_RETRIES,
  },
  settlementRecon: {
    intervalMs: env.SETTLEMENT_RECON_INTERVAL_MS,
  },
  revenueLedgerIndexer: {
    intervalMs: env.REVENUE_LEDGER_INDEXER_INTERVAL_MS,
    batchSize: env.REVENUE_LEDGER_INDEXER_BATCH_SIZE,
  },

} as const;
