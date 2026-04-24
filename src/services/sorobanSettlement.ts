import {
  SorobanRpc,
  Transaction,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';
import { withRetry, isTransientError, RetryOptions } from '../utils/retry.js';

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const MAINNET_RPC = 'https://soroban-rpc.mainnet.stellar.gateway.fm';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface SorobanSettlementOptions {
  network: StellarNetwork;
  rpcUrl?: string;
  /** Override retry policy for transient RPC failures. */
  retry?: RetryOptions;
  /** Override polling policy when waiting on `getTransaction`. */
  polling?: {
    maxAttempts?: number;
    intervalMs?: number;
  };
  /** Test seam: inject custom RPC server. */
  serverFactory?: (rpcUrl: string) => SorobanRpc.Server;
}

export class SorobanRpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SorobanRpcError';
  }
}

export class SettlementSubmissionError extends Error {
  constructor(
    message: string,
    readonly response: SorobanRpc.Api.SendTransactionResponse
  ) {
    super(message);
    this.name = 'SettlementSubmissionError';
  }
}

export class SettlementFailedError extends Error {
  constructor(
    message: string,
    readonly response: SorobanRpc.Api.GetTransactionResponse
  ) {
    super(message);
    this.name = 'SettlementFailedError';
  }
}

/**
 * Settlement RPC client wrapping `SorobanRpc.Server` calls in retry/backoff
 * for transient Horizon/Soroban errors.
 *
 * Retries are applied to each RPC call. Mutating calls (`sendTransaction`)
 * are safe to retry because Soroban deduplicates identical signed envelopes
 * and returns `DUPLICATE` rather than re-executing.
 */
export class SorobanSettlementService {
  private readonly server: SorobanRpc.Server;
  private readonly retryOptions: RetryOptions;
  private readonly pollMaxAttempts: number;
  private readonly pollIntervalMs: number;

  constructor(opts: SorobanSettlementOptions) {
    const rpcUrl = opts.rpcUrl ?? defaultRpcUrl(opts.network);
    const factory =
      opts.serverFactory ??
      ((url: string) => new SorobanRpc.Server(url, { allowHttp: false }));
    this.server = factory(rpcUrl);
    this.retryOptions = opts.retry ?? {};
    this.pollMaxAttempts = opts.polling?.maxAttempts ?? 30;
    this.pollIntervalMs = opts.polling?.intervalMs ?? 2_000;
  }

  async simulateTransaction(
    tx: Transaction | FeeBumpTransaction
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.callWithRetry(() => this.server.simulateTransaction(tx));
  }

  async sendTransaction(
    tx: Transaction | FeeBumpTransaction
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    const response = await this.callWithRetry(() =>
      this.server.sendTransaction(tx)
    );

    if (response.status === 'TRY_AGAIN_LATER') {
      // RPC explicitly asked for retry but withRetry exhausted attempts.
      throw new SettlementSubmissionError(
        'Soroban RPC asked to retry later but max attempts exhausted',
        response
      );
    }
    if (response.status === 'ERROR') {
      throw new SettlementSubmissionError(
        'Soroban RPC rejected transaction submission',
        response
      );
    }
    return response;
  }

  async getTransaction(
    hash: string
  ): Promise<SorobanRpc.Api.GetTransactionResponse> {
    return this.callWithRetry(() => this.server.getTransaction(hash));
  }

  /**
   * Submit and wait for terminal status. Polls `getTransaction` until the
   * tx leaves `NOT_FOUND` or polling budget is exhausted. Both submission
   * and each poll are individually retried for transient RPC failures.
   */
  async submitAndConfirm(
    tx: Transaction | FeeBumpTransaction,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    const sent = await this.sendTransaction(tx);

    for (let attempt = 1; attempt <= this.pollMaxAttempts; attempt++) {
      const result = await this.getTransaction(sent.hash);
      if (result.status === 'SUCCESS') {
        return result;
      }
      if (result.status === 'FAILED') {
        throw new SettlementFailedError(
          `Settlement transaction ${sent.hash} failed on-chain`,
          result
        );
      }
      // NOT_FOUND — ledger hasn't closed; keep polling.
      if (attempt < this.pollMaxAttempts) {
        await sleep(this.pollIntervalMs);
      }
    }

    throw new SorobanRpcError(
      `Timed out waiting for transaction ${sent.hash} to be included`
    );
  }

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, this.retryOptions);
    } catch (err) {
      if (isTransientError(err)) {
        throw new SorobanRpcError(
          'Soroban RPC call failed after retries',
          err
        );
      }
      throw err;
    }
  }
}

function defaultRpcUrl(network: StellarNetwork): string {
  return network === 'testnet' ? TESTNET_RPC : MAINNET_RPC;
}
