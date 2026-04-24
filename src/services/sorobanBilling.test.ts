import assert from 'node:assert/strict';

import {
  buildSorobanBalanceInvocation,
  buildSorobanDeductInvocation,
  createSorobanRpcBillingClient,
} from './sorobanBilling.js';

describe('buildSorobanBalanceInvocation', () => {
  test('assembles a balance invocation for a user id', () => {
    assert.deepEqual(
      buildSorobanBalanceInvocation('contract_123', 'user_abc'),
      {
        contractId: 'contract_123',
        function: 'balance',
        args: [{ type: 'string', value: 'user_abc' }],
      }
    );
  });
});

describe('buildSorobanDeductInvocation', () => {
  test('assembles a deduct invocation with optional idempotency key', () => {
    assert.deepEqual(
      buildSorobanDeductInvocation('contract_123', 'user_abc', '150000', 'req_1'),
      {
        contractId: 'contract_123',
        function: 'deduct',
        args: [
          { type: 'string', value: 'user_abc' },
          { type: 'i128', value: '150000' },
          { type: 'string', value: 'req_1' },
        ],
      }
    );
  });
});

describe('SorobanRpcBillingClient', () => {
  test('posts a balance invocation and normalizes the returned balance', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          value: '1234567',
        },
      }),
    }));

    const client = createSorobanRpcBillingClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => 'req-balance',
    });

    const result = await client.getBalance('user_123');

    assert.deepEqual(result, { balance: '1234567' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('posts a deduct invocation and returns the transaction hash', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          transactionHash: '0xbilling123',
        },
      }),
    }));

    const client = createSorobanRpcBillingClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => 'req-deduct',
      sourceAccount: 'G_SOURCE_ACCOUNT',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    const result = await client.deductBalance('user_123', '250000', 'req_123');

    assert.deepEqual(result, { txHash: '0xbilling123' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [, init] = firstCall;
    assert.deepEqual(JSON.parse(String(init.body)), {
      jsonrpc: '2.0',
      id: 'req-deduct',
      method: 'simulateTransaction',
      params: {
        invocation: {
          contractId: 'contract_abc',
          function: 'deduct',
          args: [
            { type: 'string', value: 'user_123' },
            { type: 'i128', value: '250000' },
            { type: 'string', value: 'req_123' },
          ],
        },
        sourceAccount: 'G_SOURCE_ACCOUNT',
        networkPassphrase: 'Test SDF Network ; September 2015',
      },
    });
  });

  test('normalizes simulation failures returned by Soroban RPC', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          error: {
            message: ' insufficient balance ',
          },
        },
      }),
    })) as unknown as typeof fetch;

    const client = createSorobanRpcBillingClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl,
    });

    await assert.rejects(
      () => client.deductBalance('user_123', '1000'),
      /insufficient balance/
    );
  });
});
