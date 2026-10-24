import type { Pool } from "pg";
import { env } from "../config/env.js";
import { config } from "../config/index.js";
import { BillingService, type SorobanClient } from "./billing.js";
import { createSorobanRpcBillingClient } from "./sorobanBilling.js";

export interface SorobanBillingDependencies {
  billingSorobanClient?: SorobanClient;
  createBillingSorobanClient?: () => SorobanClient;
  billingService?: BillingService;
}

const DEFAULT_DEV_RPC_URL = "http://localhost:8000";

function resolveBillingRpcUrl(): string {
  const explicit = env.SOROBAN_BILLING_RPC_URL ?? env.SOROBAN_RPC_URL;
  if (explicit) return explicit;

  const activeRpcUrl = config.stellar.rpcUrl;
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
  if (dependencies?.billingService) return dependencies.billingService;

  const injectedClient = dependencies?.billingSorobanClient ??
    dependencies?.createBillingSorobanClient?.();
  if (injectedClient) return new BillingService(pool, injectedClient);

  const contractId = resolveBillingContractId();
  if (!contractId) return undefined;

  processBillingService ??= new BillingService(
    pool,
    createSorobanRpcBillingClient({
      rpcUrl: resolveBillingRpcUrl(),
      contractId,
      sourceAccount: env.SOROBAN_BILLING_SOURCE_ACCOUNT,
      networkPassphrase: resolveBillingNetworkPassphrase(),
      requestTimeoutMs: env.SOROBAN_BILLING_RPC_TIMEOUT_MS,
      balanceFunctionName: env.SOROBAN_BILLING_BALANCE_FN,
      deductFunctionName: env.SOROBAN_BILLING_DETUCT_FN,
    }),
  );
  return processBillingService;
}
