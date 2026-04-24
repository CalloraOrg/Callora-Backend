import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  SorobanSettlementService,
  SorobanRpcError,
  SettlementSubmissionError,
  SettlementFailedError,
} from './sorobanSettlement.js';

// Minimal fake mirroring SorobanRpc.Server surface used by the service.
interface FakeServer {
  simulateTransaction: ReturnType<typeof makeFn>;
  sendTransaction: ReturnType<typeof makeFn>;
  getTransaction: ReturnType<typeof makeFn>;
}

function makeFn() {
  const calls: unknown[][] = [];
  let queue: Array<() => unknown> = [];
  const fn = async (...args: unknown[]) => {
    calls.push(args);
    const next = queue.shift();
    if (!next) throw new Error('fake unprogrammed');
    const v = next();
    return v;
  };
  fn.calls = calls;
  fn.enqueue = (p: () => unknown) => queue.push(p);
  fn.reset = () => {
    queue = [];
    calls.length = 0;
  };
  return fn;
}

function makeService(server: FakeServer, overrides: object = {}) {
  return new SorobanSettlementService({
    network: 'testnet',
    serverFactory: () => server as never,
    retry: {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    polling: { maxAttempts: 5, intervalMs: 1 },
    ...overrides,
  });
}

describe('SorobanSettlementService', () => {
  it('sendTransaction retries transient TRY_AGAIN_LATER and resolves', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    server.sendTransaction.enqueue(() => {
      const e = new Error('rate limit') as Error & { status: number };
      e.status = 429;
      throw e;
    });
    server.sendTransaction.enqueue(() => ({
      status: 'PENDING',
      hash: 'abc',
    }));

    const svc = makeService(server);
    const tx = {} as never;
    const res = await svc.sendTransaction(tx);
    assert.strictEqual(res.status, 'PENDING');
    assert.strictEqual(server.sendTransaction.calls.length, 2);
  });

  it('sendTransaction throws SettlementSubmissionError on ERROR status', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    server.sendTransaction.enqueue(() => ({
      status: 'ERROR',
      hash: 'abc',
      errorResult: {},
    }));

    const svc = makeService(server);
    await assert.rejects(
      svc.sendTransaction({} as never),
      SettlementSubmissionError
    );
  });

  it('sendTransaction wraps exhausted transient retries as SorobanRpcError', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    for (let i = 0; i < 3; i++) {
      server.sendTransaction.enqueue(() => {
        const e = new Error('boom') as Error & { code: string };
        e.code = 'ECONNRESET';
        throw e;
      });
    }
    const svc = makeService(server);
    await assert.rejects(svc.sendTransaction({} as never), SorobanRpcError);
    assert.strictEqual(server.sendTransaction.calls.length, 3);
  });

  it('submitAndConfirm polls past NOT_FOUND until SUCCESS', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    server.sendTransaction.enqueue(() => ({
      status: 'PENDING',
      hash: 'tx-1',
    }));
    server.getTransaction.enqueue(() => ({ status: 'NOT_FOUND' }));
    server.getTransaction.enqueue(() => ({ status: 'NOT_FOUND' }));
    server.getTransaction.enqueue(() => ({
      status: 'SUCCESS',
      ledger: 42,
    }));

    const svc = makeService(server);
    const result = await svc.submitAndConfirm({} as never, () =>
      Promise.resolve()
    );
    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(server.getTransaction.calls.length, 3);
  });

  it('submitAndConfirm throws SettlementFailedError on FAILED', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    server.sendTransaction.enqueue(() => ({
      status: 'PENDING',
      hash: 'tx-1',
    }));
    server.getTransaction.enqueue(() => ({ status: 'FAILED' }));

    const svc = makeService(server);
    await assert.rejects(
      svc.submitAndConfirm({} as never, () => Promise.resolve()),
      SettlementFailedError
    );
  });

  it('submitAndConfirm times out after pollMaxAttempts', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    server.sendTransaction.enqueue(() => ({
      status: 'PENDING',
      hash: 'tx-1',
    }));
    for (let i = 0; i < 5; i++) {
      server.getTransaction.enqueue(() => ({ status: 'NOT_FOUND' }));
    }
    const svc = makeService(server);
    await assert.rejects(
      svc.submitAndConfirm({} as never, () => Promise.resolve()),
      /Timed out waiting/
    );
  });

  it('getTransaction retries transient and returns response', async () => {
    const server: FakeServer = {
      simulateTransaction: makeFn(),
      sendTransaction: makeFn(),
      getTransaction: makeFn(),
    };
    server.getTransaction.enqueue(() => {
      const e = new Error('5xx') as Error & { status: number };
      e.status = 502;
      throw e;
    });
    server.getTransaction.enqueue(() => ({ status: 'SUCCESS', ledger: 1 }));
    const svc = makeService(server);
    const res = await svc.getTransaction('hash');
    assert.strictEqual(res.status, 'SUCCESS');
    assert.strictEqual(server.getTransaction.calls.length, 2);
  });
});
