import { env } from "./env.js";

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

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  version: env.APP_VERSION,

  databaseUrl: env.DATABASE_URL,
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
    upstreamUrl: env.UPSTREAM_URL,
    timeoutMs: env.PROXY_TIMEOUT_MS,
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
} as const;
