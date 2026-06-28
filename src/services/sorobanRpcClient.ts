import { CircuitBreaker, CircuitBreakerConfig, createCircuitBreaker } from '../lib/circuitBreaker.js';
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

export class SorobanRpcClient {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: SorobanRpcClientOptions) {
    this.rpcUrl = options.rpcUrl;
    this.fetchImpl = options.fetchImpl ?? (env.SOROBAN_CHAOS ? withSorobanLatencyWrapper(fetch) : fetch);
    this.timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.circuitBreaker = createCircuitBreaker(options.circuitBreakerConfig);
  }

  async request<T = any>(method: string, params?: any): Promise<T> {
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

        const data = await response.json() as any;
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
