import type { Pool } from "pg";
import { env } from "../config/env.js";
import { BillingService, type SorobanClient } from "./billing.js";
import { createSorobanRpcBillingClient } from "./sorobanBilling.js";

export interface SorobanBillingDependencies {
  billingSorobanClient?: SorobanClient;
  createBillingSorobanClient?: () => SorobanClient;
  billingService?: BillingService;
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

  if (!env.SOROBAN_BILLING_CONTRACT_ID) return undefined;

  processBillingService ??= new BillingService(
    pool,
    createSorobanRpcBillingClient({
      rpcUrl:
        env.SOROBAN_BILLING_RPC_URL ??
        env.SOROBAN_RPC_URL ??
        "http://localhost:8000",
      contractId: env.SOROBAN_BILLING_CONTRACT_ID,
      sourceAccount: env.SOROBAN_BILLING_SOURCE_ACCOUNT,
      networkPassphrase: env.SOROBAN_BILLING_NETWORK_PASSPHRASE,
      requestTimeoutMs: env.SOROBAN_BILLING_RPC_TIMEOUT_MS,
      balanceFunctionName: env.SOROBAN_BILLING_BALANCE_FN,
      deductFunctionName: env.SOROBAN_BILLING_DEDUCT_FN,
    }),
  );
  return processBillingService;
}
