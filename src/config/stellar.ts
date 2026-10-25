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
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function validateStellarEndpointUrl(name: string, rawUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLocalStellarHost(parsed.hostname))
  ) {
    throw new Error(
      `${name} must use HTTPS unless it targets localhost for local development.`,
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
    env.STELLAR_TESTNET_HORIZON_URL,
  ),
  sorobanRpcUrl: validateStellarEndpointUrl(
    "SOROBAN_TESTNET_RPC_URL",
    env.SOROBAN_TESTNET_RPC_URL,
  ),
  networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  vaultContractId: env.STELLAR_TESTNET_VAULT_CONTRACT_ID,
  settlementContractId: env.STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID,
};

const mainnetConfig: StellarNetworkConfig = {
  horizonUrl: validateStellarEndpointUrl(
    "STELLAR_MAINNET_HORIZON_URL",
    env.STELLAR_MAINNET_HORIZON_URL,
  ),
  sorobanRpcUrl: validateStellarEndpointUrl(
    "SOROBAN_MAINNET_RPC_URL",
    env.SOROBAN_MAINNET_RPC_URL,
  ),
  networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
  vaultContractId: env.STELLAR_MAINNET_VAULT_CONTRACT_ID,
  settlementContractId: env.STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID,
};

const activeConfig =
  selectedNetwork === "mainnet" ? mainnetConfig : testnetConfig;

// Derive billing network settings from the active network unless explicitly overridden.
// The override must match the active network passphrase (enforced in env superRefine).
const billingNetworkPassphrase =
  env.SOROBAN_BILLING_NETWORK_PASSPHRASE ?? activeConfig.networkPassphrase;

const billingRpcUrl =
  env.SOROBAN_BILLING_RPC_URL ??
  env.SOROBAN_RPC_URL ??
  activeConfig.sorobanRpcUrl;

const billingContractId =
  env.SOROBAN_BILLING_CONTRACT_ID ?? activeConfig.vaultContractId;

// Log once at startup when the billing contract id is an explicit override
// of the active network's vault contract id.
const billingContractIsOverride =
  Boolean(env.SOROBAN_BILLING_CONTRACT_ID) &&
  Boolean(activeConfig.vaultContractId) === true &&
  env.SOROBAN_BILLING_CONTRACT_ID !== activeConfig.vaultContractId;

if (billingContractIsOverride) {
  console.warn(
    "SOROBAN_BILLING_CONTRACT_ID differs from the active network's vault contract id; treating it as an explicit override.",
  );
}


export { activeConfig, mainnetConfig, selectedNetwork, testnetConfig, billingNetworkPassphrase, billingRpcUrl, billingContractId };
