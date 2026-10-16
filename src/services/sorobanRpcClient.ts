import { CircuitBreaker, CircuitBreakerConfig, createCircuitBreaker } from '../lib/circuitBreaker.js';
import { BadRequestError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { withSorobanLatencyWrapper } from '../../tests/chaos/sorobanLatency.js';

const DEFAULT_TIMEOUT_MS = 5000;
const BREAKER_KEY = 'soroban-rpc';

export interface SorobanRpcClientOptions {
  rpcUrl: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  circuitBreakerConfig?: CircuitBreakerConfig;
}

interface SorobanRpcResponse<T = unknown> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: { code: number; message: string };
}

function validateSorobanRpcClientOptions(options: SorobanRpcClientOptions): void {
  if (!options || typeof options !== 'object') {
    throw new BadRequestError('SorobanRpcClient options must be an object');
  }
  if (typeof options.rpcUrl !== 'string' || options.rpcUrl.trim().length === 0) {
    throw new BadRequestError('rpcUrl must be a non-empty HTTP(S) URL');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.rpcUrl);
  } catch {
    throw new BadRequestError('rpcUrl must be a valid HTTP(S) URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new BadRequestError('rpcUrl must use http or https protocol');
  }
  if (
    options.requestTimeoutMs !== undefined &&
    (typeof options.requestTimeoutMs !== 'number' ||
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0)
  ) {
    throw new BadRequestError('requestTimeoutMs must be a positive finite number');
  }
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') {
    throw new BadRequestError('fetchImpl must be a function');
  }
}

export class SorobanRpcClient {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: SorobanRpcClientOptions) {
    validateSorobanRpcClientOptions(options);
    this.rpcUrl = options.rpcUrl.trim();
    this.fetchImpl = options.fetchImpl ?? (env.SOROBAN_CHAOS ? withSorobanLatencyWrapper(fetch) : fetch);
    this.timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.circuitBreaker = createCircuitBreaker(options.circuitBreakerConfig);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (typeof method !== 'string' || method.trim().length === 0) {
      throw new BadRequestError('RPC method must be a non-empty string');
    }

    return this.circuitBreaker.execute(BREAKER_KEY, async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await this.fetchImpl(this.rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now().toString(),
            method,
            params,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Soroban RPC request failed with status ${response.status}`);
        }

        const data = await response.json() as SorobanRpcResponse<T>;
        if (data.error) {
          throw new Error(`Soroban RPC error: ${data.error.message}`);
        }

        return data.result as T;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }
}

export function createSorobanRpcClient(options: SorobanRpcClientOptions): SorobanRpcClient {
  return new SorobanRpcClient(options);
}
