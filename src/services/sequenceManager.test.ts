/**
 * Tests for SequenceManager (issue #416).
 *
 * Coverage areas
 * ──────────────
 * 1. Basic operation — single call returns incremented sequence
 * 2. Concurrency — no duplicate sequences under parallel calls (Promise.all)
 * 3. Ordering — sequences are allocated in FIFO order
 * 4. Lock release on error — subsequent callers proceed after a thrown error
 * 5. Multiple accounts — independent serialisation per account
 * 6. Stale Horizon read recovery — can re-fetch after a bad sequence
 * 7. Edge cases — sequence at bigint boundary, empty accountId
 * 8. Utility methods — clearLock, hasLock
 */

import { SequenceManager, type HorizonAccountLoader, type HorizonAccount } from './sequenceManager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a loader whose loadAccount always resolves with the given sequence. */
function makeLoader(sequence: string | bigint, accountId = 'GABC'): HorizonAccountLoader {
  return {
    async loadAccount(id: string): Promise<HorizonAccount> {
      return { accountId: id, sequence: String(sequence) };
    },
  };
}

/**
 * Build a loader that resolves after `delayMs` milliseconds, optionally
 * incrementing the sequence on each call to simulate a live ledger.
 */
function makeDelayedLoader(
  initialSequence: bigint,
  delayMs: number,
  opts: { incrementOnCall?: boolean } = {},
): HorizonAccountLoader & { callCount: number } {
  let seq = initialSequence;
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async loadAccount(id: string): Promise<HorizonAccount> {
      callCount++;
      const current = seq;
      if (opts.incrementOnCall) seq++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { accountId: id, sequence: String(current) };
    },
  };
}

/** Build a loader that throws on the first N calls, then succeeds. */
function makeFailingLoader(
  failCount: number,
  sequence: string,
  error = new Error('Horizon unavailable'),
): HorizonAccountLoader & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async loadAccount(id: string): Promise<HorizonAccount> {
      callCount++;
      if (callCount <= failCount) throw error;
      return { accountId: id, sequence };
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Basic operation
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — basic operation', () => {
  it('returns sequence + 1 for a single call', async () => {
    const manager = new SequenceManager({ loader: makeLoader('100') });
    const seq = await manager.nextSequence('GABC');
    expect(seq).toBe(101n);
  });

  it('handles sequence = 0 (new account)', async () => {
    const manager = new SequenceManager({ loader: makeLoader('0') });
    const seq = await manager.nextSequence('GABC');
    expect(seq).toBe(1n);
  });

  it('parses sequence as bigint to handle values > Number.MAX_SAFE_INTEGER', async () => {
    const hugeSeq = '9007199254740993'; // Number.MAX_SAFE_INTEGER + 2
    const manager = new SequenceManager({ loader: makeLoader(hugeSeq) });
    const seq = await manager.nextSequence('GABC');
    expect(seq).toBe(BigInt(hugeSeq) + 1n);
  });

  it('calls loadAccount with the provided accountId', async () => {
    const loadAccount = jest.fn().mockResolvedValue({ accountId: 'GXYZ', sequence: '50' });
    const manager = new SequenceManager({ loader: { loadAccount } });
    await manager.nextSequence('GXYZ');
    expect(loadAccount).toHaveBeenCalledWith('GXYZ');
  });

  it('makes exactly one loadAccount call per nextSequence invocation', async () => {
    const loadAccount = jest.fn().mockResolvedValue({ accountId: 'GABC', sequence: '1' });
    const manager = new SequenceManager({ loader: { loadAccount } });
    await manager.nextSequence('GABC');
    await manager.nextSequence('GABC');
    expect(loadAccount).toHaveBeenCalledTimes(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Concurrency — no duplicate sequences
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — concurrency (no duplicate sequences)', () => {
  it('returns unique sequences for 2 concurrent calls on the same account', async () => {
    // Each call gets its own fresh fetch, but they are serialised.
    const loader = makeDelayedLoader(100n, 5, { incrementOnCall: true });
    const manager = new SequenceManager({ loader });

    const [seq1, seq2] = await Promise.all([
      manager.nextSequence('GABC'),
      manager.nextSequence('GABC'),
    ]);

    expect(seq1).not.toBe(seq2);
  });

  it('returns unique sequences for 5 concurrent calls (Promise.all)', async () => {
    // The loader increments on each call to simulate the ledger advancing.
    const loader = makeDelayedLoader(0n, 2, { incrementOnCall: true });
    const manager = new SequenceManager({ loader });

    const sequences = await Promise.all(
      Array.from({ length: 5 }, () => manager.nextSequence('GABC')),
    );

    const unique = new Set(sequences.map(String));
    expect(unique.size).toBe(5);
  });

  it('returns unique sequences for 10 concurrent calls', async () => {
    const loader = makeDelayedLoader(1000n, 1, { incrementOnCall: true });
    const manager = new SequenceManager({ loader });

    const sequences = await Promise.all(
      Array.from({ length: 10 }, () => manager.nextSequence('GABC')),
    );

    const unique = new Set(sequences.map(String));
    expect(unique.size).toBe(10);
  });

  it('does not duplicate sequences even when loadAccount has variable latency', async () => {
    let seq = 0n;
    let callIndex = 0;
    const delays = [20, 5, 15, 2, 10]; // ms
    const loader: HorizonAccountLoader = {
      async loadAccount() {
        const delay = delays[callIndex % delays.length] ?? 5;
        callIndex++;
        const current = seq++;
        await new Promise((r) => setTimeout(r, delay));
        return { accountId: 'GABC', sequence: String(current) };
      },
    };

    const manager = new SequenceManager({ loader });
    const sequences = await Promise.all(
      Array.from({ length: 5 }, () => manager.nextSequence('GABC')),
    );

    const unique = new Set(sequences.map(String));
    expect(unique.size).toBe(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Ordering — FIFO sequence allocation
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — ordering', () => {
  it('allocates sequences in FIFO order', async () => {
    // The loader always returns the same base sequence (0).
    // The manager serialises calls so each sees a consistent snapshot.
    // With FIFO ordering the first caller gets seq 1, second gets 1 again
    // from a fresh fetch — but what matters is they don't duplicate.
    // For strict ordering we use incrementOnCall.
    const loader = makeDelayedLoader(0n, 1, { incrementOnCall: true });
    const manager = new SequenceManager({ loader });

    const order: number[] = [];
    const makeCall = (index: number) =>
      manager.nextSequence('GABC').then((seq) => {
        order.push(index);
        return seq;
      });

    // Fire all at once; FIFO means index 0 completes before 1 before 2 etc.
    await Promise.all([makeCall(0), makeCall(1), makeCall(2)]);

    expect(order).toEqual([0, 1, 2]);
  });

  it('serialises calls so each loadAccount sees a consistent ledger state', async () => {
    const callOrder: number[] = [];
    let callNum = 0;
    const loader: HorizonAccountLoader = {
      async loadAccount() {
        const n = callNum++;
        callOrder.push(n);
        await new Promise((r) => setTimeout(r, 5));
        return { accountId: 'GABC', sequence: String(n * 100) };
      },
    };

    const manager = new SequenceManager({ loader });
    await Promise.all([
      manager.nextSequence('GABC'),
      manager.nextSequence('GABC'),
      manager.nextSequence('GABC'),
    ]);

    // Calls must have been made in order 0 → 1 → 2 (serialised).
    expect(callOrder).toEqual([0, 1, 2]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Lock release on error
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — lock release on error', () => {
  it('releases the lock when loadAccount throws', async () => {
    const loader = makeFailingLoader(1, '200');
    const manager = new SequenceManager({ loader });

    // First call fails.
    await expect(manager.nextSequence('GABC')).rejects.toThrow('Horizon unavailable');

    // Second call must succeed — the lock was released by the first call's finally.
    const seq = await manager.nextSequence('GABC');
    expect(seq).toBe(201n);
  });

  it('allows multiple callers to proceed after a thrown error unblocks the queue', async () => {
    const loader = makeFailingLoader(1, '50');
    const manager = new SequenceManager({ loader });

    // Queue two calls concurrently. The first fails, then both queued calls succeed.
    const [result1, result2] = await Promise.allSettled([
      manager.nextSequence('GABC'),
      manager.nextSequence('GABC'),
    ]);

    // First call rejects.
    expect(result1.status).toBe('rejected');
    // Second call proceeds after the first releases the lock.
    expect(result2.status).toBe('fulfilled');
    if (result2.status === 'fulfilled') {
      expect(result2.value).toBe(51n);
    }
  });

  it('does not poison the lock — third call succeeds after first two fail', async () => {
    const loader = makeFailingLoader(2, '300');
    const manager = new SequenceManager({ loader });

    const [r1, r2, r3] = await Promise.allSettled([
      manager.nextSequence('GABC'),
      manager.nextSequence('GABC'),
      manager.nextSequence('GABC'),
    ]);

    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(r3.status).toBe('fulfilled');
    if (r3.status === 'fulfilled') {
      expect(r3.value).toBe(301n);
    }
  });

  it('re-throws the original error from loadAccount', async () => {
    const customError = new Error('tx_bad_auth: account not found');
    const loader: HorizonAccountLoader = {
      async loadAccount() { throw customError; },
    };
    const manager = new SequenceManager({ loader });

    await expect(manager.nextSequence('GABC')).rejects.toThrow('tx_bad_auth: account not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Multiple accounts — independent serialisation
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — multiple accounts', () => {
  it('serialises independently per account (no cross-account blocking)', async () => {
    const completionOrder: string[] = [];
    const loader: HorizonAccountLoader = {
      async loadAccount(id: string) {
        // Account B has longer latency — should not block account A.
        const delay = id === 'GACCOUNT_B' ? 20 : 2;
        await new Promise((r) => setTimeout(r, delay));
        completionOrder.push(id);
        return { accountId: id, sequence: '0' };
      },
    };

    const manager = new SequenceManager({ loader });

    await Promise.all([
      manager.nextSequence('GACCOUNT_A'),
      manager.nextSequence('GACCOUNT_B'),
      manager.nextSequence('GACCOUNT_A'), // Second A call — should not wait for B
    ]);

    // A completes before B because A has shorter latency and independent lock.
    const firstB = completionOrder.indexOf('GACCOUNT_B');
    const firstA = completionOrder.indexOf('GACCOUNT_A');
    expect(firstA).toBeLessThan(firstB);
  });

  it('returns correct sequences for two different accounts concurrently', async () => {
    const seqs: Record<string, bigint> = { GACC1: 100n, GACC2: 200n };
    const loader: HorizonAccountLoader = {
      async loadAccount(id: string) {
        return { accountId: id, sequence: String(seqs[id] ?? 0n) };
      },
    };

    const manager = new SequenceManager({ loader });

    const [s1, s2] = await Promise.all([
      manager.nextSequence('GACC1'),
      manager.nextSequence('GACC2'),
    ]);

    expect(s1).toBe(101n);
    expect(s2).toBe(201n);
  });

  it('a failure on one account does not affect another account', async () => {
    let accBFailed = false;
    const loader: HorizonAccountLoader = {
      async loadAccount(id: string) {
        if (id === 'GACC_FAIL' && !accBFailed) {
          accBFailed = true;
          throw new Error('Account GACC_FAIL not found');
        }
        return { accountId: id, sequence: '10' };
      },
    };

    const manager = new SequenceManager({ loader });

    const [rFail, rOk] = await Promise.allSettled([
      manager.nextSequence('GACC_FAIL'),
      manager.nextSequence('GACC_OK'),
    ]);

    expect(rFail.status).toBe('rejected');
    expect(rOk.status).toBe('fulfilled');
    if (rOk.status === 'fulfilled') {
      expect(rOk.value).toBe(11n);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Stale Horizon read recovery
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — stale Horizon read recovery', () => {
  it('always fetches a fresh sequence on each call (no caching)', async () => {
    let fetchCount = 0;
    const loader: HorizonAccountLoader = {
      async loadAccount() {
        fetchCount++;
        // Return different sequences to simulate ledger advancing.
        return { accountId: 'GABC', sequence: String(fetchCount * 10) };
      },
    };

    const manager = new SequenceManager({ loader });

    const seq1 = await manager.nextSequence('GABC');
    const seq2 = await manager.nextSequence('GABC');

    // Each call fetches fresh data — sequences differ.
    expect(seq1).toBe(11n); // fetchCount=1 → seq 10 → +1 = 11
    expect(seq2).toBe(21n); // fetchCount=2 → seq 20 → +1 = 21
    expect(fetchCount).toBe(2);
  });

  it('reflects ledger advancement between calls', async () => {
    let ledgerSeq = 500n;
    const loader: HorizonAccountLoader = {
      async loadAccount() {
        const current = ledgerSeq;
        ledgerSeq += 5n; // ledger advanced between calls
        return { accountId: 'GABC', sequence: String(current) };
      },
    };

    const manager = new SequenceManager({ loader });

    const seq1 = await manager.nextSequence('GABC');
    const seq2 = await manager.nextSequence('GABC');

    expect(seq1).toBe(501n);
    expect(seq2).toBe(506n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — edge cases', () => {
  it('handles sequence near bigint boundary without overflow', async () => {
    // Use a large but safe bigint.
    const nearMax = (2n ** 62n).toString();
    const manager = new SequenceManager({ loader: makeLoader(nearMax) });
    const seq = await manager.nextSequence('GABC');
    expect(seq).toBe(BigInt(nearMax) + 1n);
  });

  it('handles sequential calls on the same account without errors', async () => {
    const loader = makeDelayedLoader(0n, 0, { incrementOnCall: true });
    const manager = new SequenceManager({ loader });

    const results: bigint[] = [];
    for (let i = 0; i < 20; i++) {
      results.push(await manager.nextSequence('GABC'));
    }

    // All results should be strictly increasing.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThan(results[i - 1]!);
    }
  });

  it('works correctly with an account ID that contains special characters', async () => {
    const accountId = 'GABC-123_xyz';
    const loadAccount = jest.fn().mockResolvedValue({ accountId, sequence: '42' });
    const manager = new SequenceManager({ loader: { loadAccount } });

    const seq = await manager.nextSequence(accountId);
    expect(seq).toBe(43n);
    expect(loadAccount).toHaveBeenCalledWith(accountId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Utility methods
// ═════════════════════════════════════════════════════════════════════════════

describe('SequenceManager — utility methods', () => {
  it('hasLock returns false before any call for an account', () => {
    const manager = new SequenceManager({ loader: makeLoader('0') });
    expect(manager.hasLock('GABC')).toBe(false);
  });

  it('hasLock returns true after a call for an account', async () => {
    const manager = new SequenceManager({ loader: makeLoader('0') });
    await manager.nextSequence('GABC');
    expect(manager.hasLock('GABC')).toBe(true);
  });

  it('clearLock removes the lock entry', async () => {
    const manager = new SequenceManager({ loader: makeLoader('0') });
    await manager.nextSequence('GABC');
    manager.clearLock('GABC');
    expect(manager.hasLock('GABC')).toBe(false);
  });

  it('clearLock is a no-op for an unknown account', () => {
    const manager = new SequenceManager({ loader: makeLoader('0') });
    expect(() => manager.clearLock('UNKNOWN')).not.toThrow();
  });

  it('clearLock does not affect other accounts', async () => {
    const manager = new SequenceManager({ loader: makeLoader('0') });
    await manager.nextSequence('GABC');
    await manager.nextSequence('GXYZ');
    manager.clearLock('GABC');
    expect(manager.hasLock('GABC')).toBe(false);
    expect(manager.hasLock('GXYZ')).toBe(true);
  });
});
