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
        throw new Error(`Soroban RPC request failed: HTTP ${response.status}`);
      }

      const payload = await response.json() as Record<string, unknown>;
      const simulationError = extractSimulationError(payload);
      if (simulationError) {
        throw new Error(normalizeSorobanBillingError(simulationError, 'Simulation failed'));
      }

      const result = extractRpcResult(payload);
      if (!result) {
        throw new Error('Missing result in Soroban RPC response');
      }

      return result;
    } catch (error) {
      throw new Error(normalizeSorobanBillingError(error, 'Soroban RPC request failed'));
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
