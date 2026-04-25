import { config, type StellarNetwork } from '../config/index.js';
import {
  withRetry,
  TransientError,
  RETRIABLE_HTTP_STATUSES,
  isTransientNetworkError,
  type RetryOptions,
} from '../lib/retry.js';

export interface PayoutResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface SorobanInvocationArg {
  type: 'address' | 'i128';
  value: string;
}

export interface SorobanSettlementInvocation {
  contractId: string;
  function: 'distribute';
  args: SorobanInvocationArg[];
}

export interface SorobanSimulationRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'simulateTransaction';
  params: {
    invocation: SorobanSettlementInvocation;
    sourceAccount?: string;
    networkPassphrase?: string;
  };
}

export interface SorobanRpcSettlementClientOptions {
  rpcUrl?: string;
  contractId?: string;
  network?: StellarNetwork;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Maximum number of retries after the first attempt. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 500. */
  retryBaseDelayMs?: number;
  requestIdFactory?: () => string;
  sourceAccount?: string;
  networkPassphrase?: string;
}

export interface SorobanSettlementClient {
  /** Transfer USDC to developer address. */
  distribute(developerAddress: string, amountUsdc: number): Promise<PayoutResult>;
}

const USDC_STROOPS_MULTIPLIER = 10_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

interface ResolvedSorobanRpcSettlementClientOptions
  extends Omit<SorobanRpcSettlementClientOptions, 'rpcUrl' | 'contractId' | 'networkPassphrase'> {
  rpcUrl: string;
  contractId: string;
  networkPassphrase?: string;
}

function resolveSorobanRpcOptions(
  options: SorobanRpcSettlementClientOptions
): ResolvedSorobanRpcSettlementClientOptions {
  const selectedNetwork = options.network ?? config.stellar.network;

  if (selectedNetwork !== config.stellar.network) {
    throw new Error(
      `Configured network is '${config.stellar.network}' but settlement client requested '${selectedNetwork}'. Cross-network mixing is not allowed.`
    );
  }

  const selectedNetworkConfig = config.stellar.networks[selectedNetwork];
  const contractId = options.contractId ?? selectedNetworkConfig.settlementContractId;
  if (!contractId) {
    throw new Error(
      `Missing settlement contract ID for ${selectedNetwork}. Set STELLAR_${selectedNetwork === 'testnet' ? 'TESTNET' : 'MAINNET'}_SETTLEMENT_CONTRACT_ID.`
    );
  }

  return {
    ...options,
    rpcUrl: options.rpcUrl ?? selectedNetworkConfig.sorobanRpcUrl,
    contractId,
    networkPassphrase: options.networkPassphrase ?? selectedNetworkConfig.networkPassphrase,
  };
}

function convertUsdcToStroops(amountUsdc: number): string {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error('Settlement amount must be greater than zero');
  }

  const amountStroops = Math.round((amountUsdc + Number.EPSILON) * USDC_STROOPS_MULTIPLIER);
  if (amountStroops <= 0) {
    throw new Error('Settlement amount must be greater than zero');
  }

  return String(amountStroops);
}

function extractErrorMessage(error: unknown, depth = 0): string | undefined {
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
    const directKeys = ['message', 'detail', 'details', 'title'] as const;
    for (const key of directKeys) {
      const message = extractErrorMessage(record[key], depth + 1);
      if (message) {
        return message;
      }
    }

    const nestedKeys = ['error', 'errors', 'data', 'result'] as const;
    for (const key of nestedKeys) {
      const message = extractErrorMessage(record[key], depth + 1);
      if (message) {
        return message;
      }
    }
  }

  return undefined;
}

export function normalizeSorobanError(
  error: unknown,
  fallback = 'Unknown Soroban error'
): string {
  const message = extractErrorMessage(error);
  if (!message) {
    return fallback;
  }

  return message.replace(/\s+/g, ' ').trim();
}

export function buildSorobanSettlementInvocation(
  contractId: string,
  developerAddress: string,
  amountUsdc: number
): SorobanSettlementInvocation {
  return {
    contractId,
    function: 'distribute',
    args: [
      { type: 'address', value: developerAddress },
      { type: 'i128', value: convertUsdcToStroops(amountUsdc) },
    ],
  };
}

export class SorobanRpcSettlementClient implements SorobanSettlementClient {
  private readonly fetchImpl: typeof fetch;
  private readonly resolvedOptions: ResolvedSorobanRpcSettlementClientOptions;

  constructor(private readonly options: SorobanRpcSettlementClientOptions) {
    this.resolvedOptions = resolveSorobanRpcOptions(options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async distribute(developerAddress: string, amountUsdc: number): Promise<PayoutResult> {
    let invocation: SorobanSettlementInvocation;

    try {
      invocation = buildSorobanSettlementInvocation(
        this.resolvedOptions.contractId,
        developerAddress,
        amountUsdc,
      );
    } catch (error) {
      return {
        success: false,
        error: normalizeSorobanError(error, 'Failed to assemble Soroban settlement invocation'),
      };
    }

    const requestBody: SorobanSimulationRequest = {
      jsonrpc: '2.0',
      id: this.options.requestIdFactory?.() ?? `soroban-settlement-${Date.now()}`,
      method: 'simulateTransaction',
      params: {
        invocation,
        sourceAccount: this.options.sourceAccount,
        networkPassphrase: this.resolvedOptions.networkPassphrase,
      },
    };

    const retryOptions: RetryOptions = {
      maxAttempts: (this.options.maxRetries ?? DEFAULT_MAX_RETRIES) + 1,
      baseDelayMs: this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      shouldRetry: isTransientNetworkError,
    };

    try {
      const response = await withRetry(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        );

        try {
          const res = await this.fetchImpl(this.resolvedOptions.rpcUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });

          // Throw inside the retry scope so transient HTTP errors are retried.
          // Non-retriable 4xx responses fall through and are handled below.
          if (RETRIABLE_HTTP_STATUSES.has(res.status)) {
            throw new TransientError(`Soroban RPC transient error: HTTP ${res.status}`);
          }

          return res;
        } finally {
          clearTimeout(timeout);
        }
      }, retryOptions);

      if (!response.ok) {
        return {
          success: false,
          error: `Soroban RPC request failed: HTTP ${response.status}`,
        };
      }

      const payload = await response.json() as Record<string, unknown>;
      const simulationError = this.getSimulationError(payload);
      if (simulationError) {
        return {
          success: false,
          error: `Simulation failed: ${normalizeSorobanError(simulationError)}`,
        };
      }

      const txHash = this.getTransactionHash(payload);
      if (!txHash) {
        return {
          success: false,
          error: 'Simulation failed: Missing transaction hash in Soroban RPC response',
        };
      }

      return { success: true, txHash };
    } catch (error) {
      return {
        success: false,
        error: `Soroban RPC request failed: ${normalizeSorobanError(error, 'Request failed')}`,
      };
    }
  }

  private getSimulationError(payload: Record<string, unknown>): unknown {
    if (payload.error) {
      return payload.error;
    }

    const result = payload.result as Record<string, unknown> | undefined;
    if (!result) {
      return undefined;
    }

    if (result.error) {
      return result.error;
    }

    const results = result.results;
    if (Array.isArray(results) && results.length > 0) {
      const firstResult = results[0];
      if (firstResult && typeof firstResult === 'object' && 'error' in firstResult) {
        return (firstResult as Record<string, unknown>).error;
      }
    }

    return undefined;
  }

  private getTransactionHash(payload: Record<string, unknown>): string | undefined {
    const result = payload.result as Record<string, unknown> | undefined;
    const candidate = result?.transactionHash ?? result?.txHash ?? result?.hash;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  }
}

export function createSorobanRpcSettlementClient(
  options: SorobanRpcSettlementClientOptions
): SorobanRpcSettlementClient {
  return new SorobanRpcSettlementClient(options);
}

export class MockSorobanSettlementClient implements SorobanSettlementClient {
  private failureRate: number;

  /**
   * @param failureRate 0.0 to 1.0 probability of a mock failure
   */
  constructor(failureRate = 0) {
    this.failureRate = failureRate;
  }

  async distribute(developerAddress: string, _amountUsdc: number): Promise<PayoutResult> {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (Math.random() < this.failureRate) {
      return { success: false, error: 'Simulated contract failure' };
    }

    const mockHash = `0xmocktx_${Date.now()}_${developerAddress.substring(0, 4)}`;
    return { success: true, txHash: mockHash };
  }
}

export function createSorobanSettlementClient(failureRate = 0): MockSorobanSettlementClient {
  return new MockSorobanSettlementClient(failureRate);
}
