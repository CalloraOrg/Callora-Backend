import { createSorobanRpcClient, SorobanRpcClient } from './sorobanRpcClient.js';
import { BadRequestError, CircuitBreakerOpenError } from '../lib/errors.js';

describe('SorobanRpcClient circuit breaker & option validation (#1305)', () => {
  const RPC_URL = 'https://soroban-testnet.stellar.org';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('opens the circuit breaker after threshold failures and fast-fails without contacting the RPC', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);

    const client = createSorobanRpcClient({
      rpcUrl: RPC_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      circuitBreakerConfig: {
        failureThreshold: 3,
        cooldownMs: 10_000,
        successThreshold: 1,
      },
    });

    for (let i = 0; i < 3; i++) {
      await expect(client.request('getHealth')).rejects.toThrow(
        'Soroban RPC request failed with status 503',
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 4th call must fast-fail with CircuitBreakerOpenError without invoking fetchMock
    await expect(client.request('getHealth')).rejects.toThrow(CircuitBreakerOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('transitions to HALF_OPEN after cooldown and closes the breaker on a successful probe', async () => {
    let shouldFail = true;
    const fetchMock = jest.fn().mockImplementation(async () => {
      if (shouldFail) {
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: '1',
          result: { status: 'healthy' },
        }),
      } as unknown as Response;
    });

    const client = createSorobanRpcClient({
      rpcUrl: RPC_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      circuitBreakerConfig: {
        failureThreshold: 2,
        cooldownMs: 5_000,
        successThreshold: 1,
      },
    });

    await expect(client.request('getHealth')).rejects.toThrow('status 502');
    await expect(client.request('getHealth')).rejects.toThrow('status 502');
    await expect(client.request('getHealth')).rejects.toThrow(CircuitBreakerOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Advance clock past cooldown window
    jest.advanceTimersByTime(5_001);
    shouldFail = false;

    // Probe request succeeds and closes the circuit breaker
    const probeResult = await client.request<{ status: string }>('getHealth');
    expect(probeResult).toEqual({ status: 'healthy' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Subsequent calls pass through normally
    const followUp = await client.request<{ status: string }>('getHealth');
    expect(followUp).toEqual({ status: 'healthy' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('counts request timeouts (AbortController abort) as circuit breaker failures', async () => {
    const fetchMock = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }),
    );

    const client = new SorobanRpcClient({
      rpcUrl: RPC_URL,
      requestTimeoutMs: 250,
      fetchImpl: fetchMock as unknown as typeof fetch,
      circuitBreakerConfig: {
        failureThreshold: 2,
        cooldownMs: 10_000,
        successThreshold: 1,
      },
    });

    const p1 = expect(client.request('getLatestLedger')).rejects.toThrow('The operation was aborted');
    await jest.advanceTimersByTimeAsync(251);
    await p1;

    const p2 = expect(client.request('getLatestLedger')).rejects.toThrow('The operation was aborted');
    await jest.advanceTimersByTimeAsync(251);
    await p2;

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Breaker is now open due to 2 consecutive timeouts
    await expect(client.request('getLatestLedger')).rejects.toThrow(CircuitBreakerOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('validates options in createSorobanRpcClient and SorobanRpcClient constructor', () => {
    expect(() =>
      createSorobanRpcClient(null as unknown as Parameters<typeof createSorobanRpcClient>[0]),
    ).toThrow(BadRequestError);

    expect(() => createSorobanRpcClient({ rpcUrl: '' })).toThrow(BadRequestError);
    expect(() => createSorobanRpcClient({ rpcUrl: 'not-a-url' })).toThrow(BadRequestError);
    expect(() => createSorobanRpcClient({ rpcUrl: 'ftp://example.com' })).toThrow(BadRequestError);

    expect(() =>
      createSorobanRpcClient({ rpcUrl: RPC_URL, requestTimeoutMs: 0 }),
    ).toThrow(BadRequestError);
    expect(() =>
      createSorobanRpcClient({ rpcUrl: RPC_URL, requestTimeoutMs: -100 }),
    ).toThrow(BadRequestError);
    expect(() =>
      createSorobanRpcClient({ rpcUrl: RPC_URL, requestTimeoutMs: Number.NaN }),
    ).toThrow(BadRequestError);

    expect(() =>
      createSorobanRpcClient({
        rpcUrl: RPC_URL,
        fetchImpl: 'not-a-fn' as unknown as typeof fetch,
      }),
    ).toThrow(BadRequestError);

    expect(() =>
      createSorobanRpcClient({
        rpcUrl: RPC_URL,
        circuitBreakerConfig: { failureThreshold: 0 },
      }),
    ).toThrow(BadRequestError);
  });
});
