import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Horizon } from '@stellar/stellar-sdk';
import {
  TransactionBuilderService,
  NetworkError,
} from './transactionBuilder.js';

// Patch Horizon.Server.prototype.loadAccount to control retry behavior.
type LoadFn = (key: string) => Promise<unknown>;

function patchLoadAccount(fn: LoadFn) {
  const original = Horizon.Server.prototype.loadAccount;
  Horizon.Server.prototype.loadAccount = fn as never;
  return () => {
    Horizon.Server.prototype.loadAccount = original;
  };
}

describe('TransactionBuilderService retry/backoff', () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    restore = undefined;
  });

  afterEach(() => {
    restore?.();
  });

  it('retries transient Horizon errors and succeeds', async () => {
    let calls = 0;
    restore = patchLoadAccount(async () => {
      calls++;
      if (calls < 2) {
        const e = new Error('upstream') as Error & { status: number };
        e.status = 503;
        throw e;
      }
      // Minimal Account-like shape sufficient for TransactionBuilder.
      return {
        accountId: () => 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
        sequenceNumber: () => '1',
        incrementSequenceNumber: () => undefined,
      };
    });

    const svc = new TransactionBuilderService({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    const out = await svc.buildDepositTransaction({
      userPublicKey: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
      vaultContractId:
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      amountUsdc: '1.0000000',
      network: 'testnet',
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.network, 'testnet');
    assert.strictEqual(out.operation.function, 'deposit');
  });

  it('wraps non-transient Horizon error as NetworkError without retry', async () => {
    let calls = 0;
    restore = patchLoadAccount(async () => {
      calls++;
      const e = new Error('account not found') as Error & { status: number };
      e.status = 404;
      throw e;
    });

    const svc = new TransactionBuilderService({
      maxAttempts: 5,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    await assert.rejects(
      svc.buildDepositTransaction({
        userPublicKey: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
        vaultContractId:
          'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        amountUsdc: '1.0000000',
        network: 'testnet',
      }),
      NetworkError
    );
    assert.strictEqual(calls, 1);
  });

  it('throws NetworkError after exhausting transient retries', async () => {
    let calls = 0;
    restore = patchLoadAccount(async () => {
      calls++;
      const e = new Error('rate-limited') as Error & { status: number };
      e.status = 429;
      throw e;
    });

    const svc = new TransactionBuilderService({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    await assert.rejects(
      svc.buildDepositTransaction({
        userPublicKey: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
        vaultContractId:
          'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        amountUsdc: '1.0000000',
        network: 'testnet',
      }),
      NetworkError
    );
    assert.strictEqual(calls, 3);
  });
});
