import type { Pool } from "pg";
import { env } from "../config/env.js";
import { config } from "../config/index.js";
import { logger } from "../logger.js";
import type { VaultRepository } from "../repositories/vaultRepository.js";
import { BillingService, type SorobanClient } from "./billing.js";
import { SorobanVaultBillingClient } from "./sorobanVaultBillingClient.js";

export interface SorobanBillingDependencies {
  billingSorobanClient?: SorobanClient;
  createBillingSorobanClient?: () => SorobanClient;
  billingService?: BillingService;
  /**
   * Vault lookup used by the default client to resolve each user's vault
   * contract id (falling back to SOROBAN_BILLING_CONTRACT_ID when the user
   * has no registered vault).
   */
  vaultRepository?: VaultRepository;
}

const DEFAULT_DEV_RPC_URL = "http://localhost:8000";

function resolveBillingRpcUrl(): string {
  const explicit = env.SOROBAN_BILLING_RPC_URL ?? env.SOROBAN_RPC_URL;
  if (explicit) return explicit;

  const activeRpcUrl = config.stellar.sorobanRpcUrl;
  if (activeRpcUrl) return activeRpcUrl;

  if (config.nodeEnv === "development" || config.nodeEnv === "test") {
    return DEFAULT_DEV_RPC_URL;
  }

  // Validation should have rejected this configuration at startup.
  throw new Error(
    "SOROBAN_BILLING_RPC_URL is required outside development and test",
  );
}


function resolveBillingContractId(): string | undefined {
  return env.SOROBAN_BILLING_CONTRACT_ID ?? config.stellar.vaultContractId;
}

function resolveBillingNetworkPassphrase(): string {
  return (
    env.SOROBAN_BILLING_NETWORK_PASSPHRASE ?? config.stellar.networkPassphrase
  );
}

let processBillingService: BillingService | undefined;

export function createSorobanBillingService(
  pool: Pool,
  dependencies?: SorobanBillingDependencies,
): BillingService | undefined {
  if (config.demoMode) return undefined;
  if (dependencies?.billingService) return dependencies.billingService;

  const injectedClient = dependencies?.billingSorobanClient ??
    dependencies?.createBillingSorobanClient?.();
  if (injectedClient) return new BillingService(pool, injectedClient);

  const contractId = resolveBillingContractId();
  if (!contractId) return undefined;

  // The vault deduct is signed by the backend's authorized caller, so no
  // client can be constructed without the signing key. Missing key → no
  // (partial) client and a config warning, not a runtime failure later.
  const secretKey = env.SOROBAN_BILLING_BACKEND_SECRET_KEY;
  if (!secretKey) {
    logger.warn(
      "[createSorobanBillingService] SOROBAN_BILLING_BACKEND_SECRET_KEY is not configured — Soroban billing is disabled until the backend signing key is set",
    );
    return undefined;
  }

  processBillingService ??= new BillingService(
    pool,
    new SorobanVaultBillingClient({
      rpcUrl: resolveBillingRpcUrl(),
      contractId,
      secretKey,
      networkPassphrase: resolveBillingNetworkPassphrase(),
      network: config.stellar.network,
      vaultRepository: dependencies?.vaultRepository,
      requestTimeoutMs: env.SOROBAN_BILLING_RPC_TIMEOUT_MS,
      balanceFunctionName: env.SOROBAN_BILLING_BALANCE_FN,
      deductFunctionName: env.SOROBAN_BILLING_DEDUCT_FN,
    }),
  );
  return processBillingService;
}
