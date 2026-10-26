import type { SimulationDetails } from '../lib/simulationDiagnostics.js';

/**
 * Shared Soroban billing error types.
 *
 * The simulate-only JSON-RPC client that used to live here posted a made-up
 * `simulateTransaction` payload the real Soroban RPC does not accept, never
 * submitted anything, and invented a transaction hash from a simulation
 * response. It was removed in favour of `SorobanVaultBillingClient`
 * (src/services/sorobanVaultBillingClient.ts), which builds, signs, submits
 * and confirms real `vault.deduct(caller, amount, request_id)` transactions
 * with `@stellar/stellar-sdk`.
 *
 * `SorobanRpcError` and its stable categories are shared by the new client,
 * the billing routes and `BillingService`, so they stay here to avoid churn in
 * existing imports.
 */

/**
 * Stable error categories for Soroban RPC failures.
 * - INSUFFICIENT_BALANCE: on-chain balance too low → 402
 * - TIMEOUT: request timed out → 504
 * - CONTRACT_ERROR: contract rejected the call → 502
 * - NETWORK_ERROR: transport / HTTP failure → 502
 */
export type SorobanRpcErrorCategory =
  | 'INSUFFICIENT_BALANCE'
  | 'TIMEOUT'
  | 'CONTRACT_ERROR'
  | 'NETWORK_ERROR';

export class SorobanRpcError extends Error {
  public readonly category: SorobanRpcErrorCategory;
  public readonly simulationDetails?: SimulationDetails;

  constructor(
    message: string,
    category: SorobanRpcErrorCategory,
    simulationDetails?: SimulationDetails
  ) {
    super(message);
    this.name = 'SorobanRpcError';
    this.category = category;
    this.simulationDetails = simulationDetails;
    Object.setPrototypeOf(this, SorobanRpcError.prototype);
  }
}

/**
 * Best-effort category guess from a plain error message. Used when a failure
 * did not come back as a typed `SorobanRpcError` (transport failures, raw
 * RPC/assemble errors).
 */
export function classifySorobanRpcError(message: string): SorobanRpcErrorCategory {
  const lower = message.toLowerCase();
  if (lower.includes('insufficient balance') || lower.includes('insufficient funds')) {
    return 'INSUFFICIENT_BALANCE';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return 'TIMEOUT';
  }
  if (lower.includes('contract') || lower.includes('simulation failed') || lower.includes('wasm')) {
    return 'CONTRACT_ERROR';
  }
  return 'NETWORK_ERROR';
}

/**
 * Pull a human-readable message out of an unknown thrown value without
 * dumping the whole object (which may carry XDR, keys or addresses).
 */
export function extractErrorMessage(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || error === null || error === undefined) {
    return undefined;
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (error instanceof Error) {
    return extractErrorMessage(error.message, depth + 1);
  }

  if (Array.isArray(error)) {
    const messages = error
      .map((entry) => extractErrorMessage(entry, depth + 1))
      .filter((message): message is string => Boolean(message));
    return messages.length > 0 ? messages.join('; ') : undefined;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'detail', 'details', 'title'] as const) {
      const message = extractErrorMessage(record[key], depth + 1);
      if (message) {
        return message;
      }
    }

    for (const key of ['error', 'errors', 'data', 'result'] as const) {
      const message = extractErrorMessage(record[key], depth + 1);
      if (message) {
        return message;
      }
    }
  }

  return undefined;
}

export function normalizeSorobanBillingError(
  error: unknown,
  fallback = 'Unknown Soroban error'
): string {
  return extractErrorMessage(error)?.replace(/\s+/g, ' ').trim() ?? fallback;
}
