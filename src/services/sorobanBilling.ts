export interface SorobanBillingInvocationArg {
  type: 'string' | 'i128';
  value: string;
}

export interface SorobanBillingInvocation {
  contractId: string;
  function: string;
  args: SorobanBillingInvocationArg[];
}

export interface SorobanBillingRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'simulateTransaction';
  params: {
    invocation: SorobanBillingInvocation;
    sourceAccount?: string;
    networkPassphrase?: string;
  };
}

export interface SorobanBillingClientOptions {
  rpcUrl: string;
  contractId: string;
  sourceAccount?: string;
  networkPassphrase?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  requestIdFactory?: () => string;
  balanceFunctionName?: string;
  deductFunctionName?: string;
}

export interface SorobanBalanceResponse {
  balance: string;
}

export interface SorobanDeductResponse {
  txHash: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

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

  constructor(message: string, category: SorobanRpcErrorCategory) {
    super(message);
    this.name = 'SorobanRpcError';
    this.category = category;
    Object.setPrototypeOf(this, SorobanRpcError.prototype);
  }
}

function classifyError(message: string): SorobanRpcErrorCategory {
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

function normalizeSorobanBillingError(
  error: unknown,
  fallback = 'Unknown Soroban error'
): string {
  return extractErrorMessage(error)?.replace(/\s+/g, ' ').trim() ?? fallback;
}

export function buildSorobanBalanceInvocation(
  contractId: string,
  userId: string,
  functionName = 'balance'
): SorobanBillingInvocation {
  return {
    contractId,
    function: functionName,
    args: [{ type: 'string', value: userId }],
  };
}

export function buildSorobanDeductInvocation(
  contractId: string,
  userId: string,
  amount: string,
  idempotencyKey?: string,
  functionName = 'deduct'
): SorobanBillingInvocation {
  const args: SorobanBillingInvocationArg[] = [
    { type: 'string', value: userId },
    { type: 'i128', value: amount },
  ];

  if (idempotencyKey) {
    args.push({ type: 'string', value: idempotencyKey });
  }

  return {
    contractId,
    function: functionName,
    args,
  };
}

function extractRpcResult(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = payload.result;
  return result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
}

function extractFirstValue(result: Record<string, unknown>): unknown {
  if (Array.isArray(result.results) && result.results.length > 0) {
    const first = result.results[0];
    if (first && typeof first === 'object') {
      const record = first as Record<string, unknown>;
      if ('xdr' in record) return record.xdr;
      if ('value' in record) return record.value;
      if ('result' in record) return record.result;
    }
  }

  if ('value' in result) return result.value;
  if ('result' in result) return result.result;
  if ('balance' in result) return result.balance;
  return undefined;
}

function normalizeBalanceValue(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['balance', 'i128', 'u128', 'value']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return String(Math.trunc(candidate));
      }
    }
  }

  throw new Error('Missing balance value in Soroban RPC response');
}

function normalizeTxHash(result: Record<string, unknown>): string {
  const candidate = result.transactionHash ?? result.txHash ?? result.hash;
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return candidate;
  }
  throw new Error('Missing transaction hash in Soroban RPC response');
}

function extractSimulationError(payload: Record<string, unknown>): unknown {
  if (payload.error) {
    return payload.error;
  }

  const result = extractRpcResult(payload);
  if (!result) {
    return undefined;
  }

  if (result.error) {
    return result.error;
  }

  if (Array.isArray(result.results) && result.results.length > 0) {
    const first = result.results[0];
    if (first && typeof first === 'object' && 'error' in (first as Record<string, unknown>)) {
      return (first as Record<string, unknown>).error;
    }
  }

  return undefined;
}

export class SorobanRpcBillingClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SorobanBillingClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getBalance(userId: string): Promise<SorobanBalanceResponse> {
    const result = await this.invoke(
      buildSorobanBalanceInvocation(
        this.options.contractId,
        userId,
        this.options.balanceFunctionName ?? 'balance'
      )
    );

    return {
      balance: normalizeBalanceValue(extractFirstValue(result)),
    };
  }

  async deductBalance(
    userId: string,
    amount: string,
    idempotencyKey?: string
  ): Promise<SorobanDeductResponse> {
    const result = await this.invoke(
      buildSorobanDeductInvocation(
        this.options.contractId,
        userId,
        amount,
        idempotencyKey,
        this.options.deductFunctionName ?? 'deduct'
      )
    );

    return {
      txHash: normalizeTxHash(result),
    };
  }

  private async invoke(invocation: SorobanBillingInvocation): Promise<Record<string, unknown>> {
    const requestBody: SorobanBillingRpcRequest = {
      jsonrpc: '2.0',
      id: this.options.requestIdFactory?.() ?? `billing-${Date.now()}`,
      method: 'simulateTransaction',
      params: {
        invocation,
        sourceAccount: this.options.sourceAccount,
        networkPassphrase: this.options.networkPassphrase,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    try {
      const response = await this.fetchImpl(this.options.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = `Soroban RPC request failed: HTTP ${response.status}`;
        throw new SorobanRpcError(message, 'NETWORK_ERROR');
      }

      const payload = await response.json() as Record<string, unknown>;
      const simulationError = extractSimulationError(payload);
      if (simulationError) {
        const message = normalizeSorobanBillingError(simulationError, 'Simulation failed');
        throw new SorobanRpcError(message, classifyError(message));
      }

      const result = extractRpcResult(payload);
      if (!result) {
        throw new SorobanRpcError('Missing result in Soroban RPC response', 'NETWORK_ERROR');
      }

      return result;
    } catch (error) {
      // Re-throw SorobanRpcError as-is so the category is preserved
      if (error instanceof SorobanRpcError) {
        throw error;
      }
      const message = normalizeSorobanBillingError(error, 'Soroban RPC request failed');
      throw new SorobanRpcError(message, classifyError(message));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createSorobanRpcBillingClient(
  options: SorobanBillingClientOptions
): SorobanRpcBillingClient {
  return new SorobanRpcBillingClient(options);
}
