import assert from 'node:assert/strict';
import {
  buildSorobanSettlementInvocation,
  createSorobanRpcSettlementClient,
  normalizeSorobanError,
} from './sorobanSettlement.js';

describe('buildSorobanSettlementInvocation', () => {
  test('assembles the distribute invocation with a stroops amount', () => {
    const invocation = buildSorobanSettlementInvocation(
      'contract_123',
      'GDEVADDRESS1234567890ABCDEFGHIJKLMNOPQRSTUVWX1234567890',
      12.3456789,
    );

    assert.deepEqual(invocation, {
      contractId: 'contract_123',
      function: 'distribute',
      args: [
        {
          type: 'address',
          value: 'GDEVADDRESS1234567890ABCDEFGHIJKLMNOPQRSTUVWX1234567890',
        },
        {
          type: 'i128',
          value: '123456789',
        },
      ],
    });
  });

  test('rejects non-positive settlement amounts', () => {
    assert.throws(
      () => buildSorobanSettlementInvocation('contract_123', 'GDEVADDRESS', 0),
      /greater than zero/
    );
  });
});

describe('normalizeSorobanError', () => {
  test('extracts nested error messages', () => {
    const message = normalizeSorobanError({
      error: {
        details: [
          { message: ' host trap: balance too low ' },
        ],
      },
    });

    assert.equal(message, 'host trap: balance too low');
  });

  test('falls back when the payload has no message', () => {
    assert.equal(normalizeSorobanError({ foo: 'bar' }, 'fallback message'), 'fallback message');
  });
});

describe('SorobanRpcSettlementClient', () => {
  test('posts a simulated Soroban invocation without hitting a public endpoint', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { transactionHash: '0xsettlement123' } }),
    }));

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => 'req-fixed',
      sourceAccount: 'G_SOURCE_ACCOUNT',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 5.25);

    assert.equal(result.success, true);
    assert.equal(result.txHash, '0xsettlement123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    assert.equal(url, 'http://soroban-rpc.internal');
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json');

    assert.deepEqual(JSON.parse(String(init.body)), {
      jsonrpc: '2.0',
      id: 'req-fixed',
      method: 'simulateTransaction',
      params: {
        invocation: {
          contractId: 'contract_abc',
          function: 'distribute',
          args: [
            { type: 'address', value: 'G_DEVELOPER_ACCOUNT' },
            { type: 'i128', value: '52500000' },
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
            message: ' simulation rejected ',
          },
        },
      }),
    })) as unknown as typeof fetch;

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 8);

    assert.deepEqual(result, {
      success: false,
      error: 'Simulation failed: simulation rejected',
    });
  });

  test('normalizes thrown transport errors', async () => {
    const fetchImpl = (async () => {
      throw { error: { message: ' socket hang up ' } };
    }) as unknown as typeof fetch;

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl,
      maxRetries: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 3);

    assert.deepEqual(result, {
      success: false,
      error: 'Soroban RPC request failed: socket hang up',
    });
  });

  test('retries on transient network TypeError and succeeds', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result: { transactionHash: '0xretried' } }),
      });

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 7);

    assert.equal(result.success, true);
    assert.equal(result.txHash, '0xretried');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('retries on HTTP 503 and succeeds on second attempt', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result: { transactionHash: '0xafter503' } }),
      });

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 2);

    assert.equal(result.success, true);
    assert.equal(result.txHash, '0xafter503');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('retries on HTTP 429 and succeeds on second attempt', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result: { transactionHash: '0xafter429' } }),
      });

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 2);

    assert.equal(result.success, true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('does not retry HTTP 400 client errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 400 });

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 2);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /HTTP 400/);
    // 400 is not in RETRIABLE_HTTP_STATUSES — single attempt only
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not retry on AbortError (self-imposed timeout)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(
      Object.assign(new DOMException('The operation was aborted', 'AbortError'))
    );

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 2);

    assert.equal(result.success, false);
    // AbortError must never trigger retries
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('exhausts retries and returns failure after all 5xx attempts fail', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 2);

    assert.equal(result.success, false);
    // 3 total attempts (1 initial + 2 retries)
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('does not retry simulation body errors — they are deterministic', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: { error: { message: 'insufficient balance' } } }),
    });

    const client = createSorobanRpcSettlementClient({
      rpcUrl: 'http://soroban-rpc.internal',
      contractId: 'contract_abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseDelayMs: 0,
    });

    const result = await client.distribute('G_DEVELOPER_ACCOUNT', 2);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /insufficient balance/);
    // Simulation errors are returned by the server (200 OK) — no retry
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
