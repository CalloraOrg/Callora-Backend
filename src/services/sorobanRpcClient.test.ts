import assert from 'node:assert/strict';

import { CircuitBreakerOpenError } from '../lib/circuitBreaker.js';
import { SorobanRpcClient } from './sorobanRpcClient.js';

const RPC_URL = 'https://soroban-rpc.example.com';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

function parseBody(call: unknown[]): { jsonrpc: string; id: string; method: string; params?: unknown } {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('SorobanRpcClient', () => {
  test('returns the JSON-RPC result and posts a well-formed request', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: '1', result: { status: 'healthy' } }),
    );

    const client = new SorobanRpcClient({ rpcUrl: RPC_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.request('getHealth');

    assert.deepEqual(result, { status: 'healthy' });
    assert.equal(fetchImpl.mock.calls.length, 1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    assert.equal(url, RPC_URL);
    assert.equal(init.method, 'POST');
    const body = parseBody(fetchImpl.mock.calls[0]);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'getHealth');
    assert.equal(typeof body.id, 'string');
    assert.equal('params' in body, false);
  });

  test('includes method params in the request body', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ jsonrpc: '2.0', id: '1', result: 'ok' }));
    const client = new SorobanRpcClient({ rpcUrl: RPC_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.request('getLedgerEntries', { keys: ['a'] });

    assert.deepEqual(parseBody(fetchImpl.mock.calls[0]).params, { keys: ['a'] });
  });

  test('generates different request ids for back-to-back calls while Date.now is frozen', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      const fetchImpl = jest.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 'x', result: 'ok' }));
      const client = new SorobanRpcClient({ rpcUrl: RPC_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

      await client.request('getHealth');
      await client.request('getHealth');

      const firstId = parseBody(fetchImpl.mock.calls[0]).id;
      const secondId = parseBody(fetchImpl.mock.calls[1]).id;
      assert.equal(typeof firstId, 'string');
      assert.equal(typeof secondId, 'string');
      assert.notEqual(firstId, secondId);
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects and clears the timeout when the request exceeds requestTimeoutMs', async () => {
    jest.useFakeTimers();

    try {
      const fetchImpl = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
          }),
      );
      const client = new SorobanRpcClient({
        rpcUrl: RPC_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        requestTimeoutMs: 100,
      });

      const pending = client.request('getHealth');
      const assertion = assert.rejects(pending, /aborted by signal/);

      // Let the breaker and the request reach fetchImpl before inspecting timers.
      await jest.advanceTimersByTimeAsync(0);
      assert.equal(jest.getTimerCount(), 1);
      await jest.advanceTimersByTimeAsync(100);
      await assertion;
      assert.equal(jest.getTimerCount(), 0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects non-2xx responses with the documented message', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 502));
    const client = new SorobanRpcClient({ rpcUrl: RPC_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await assert.rejects(client.request('getHealth'), {
      message: 'Soroban RPC request failed with status 502',
    });
  });

  test('rejects JSON-RPC error responses with the documented message', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: '1', error: { code: -32600, message: 'invalid request' } }),
    );
    const client = new SorobanRpcClient({ rpcUrl: RPC_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await assert.rejects(client.request('getHealth'), {
      message: 'Soroban RPC error: invalid request',
    });
  });

  test('propagates a non-JSON response body as a parse failure', async () => {
    const fetchImpl = jest.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }) as unknown as Response,
    );
    const client = new SorobanRpcClient({ rpcUrl: RPC_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await assert.rejects(client.request('getHealth'), SyntaxError);
  });

  test('opens the circuit breaker after failureThreshold failures without calling fetch again', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 500));
    const client = new SorobanRpcClient({
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      circuitBreakerConfig: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    await assert.rejects(client.request('getHealth'), /status 500/);
    await assert.rejects(client.request('getHealth'), /status 500/);
    await assert.rejects(client.request('getHealth'), CircuitBreakerOpenError);

    assert.equal(fetchImpl.mock.calls.length, 2);
  });
});
