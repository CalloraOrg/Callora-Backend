/**
 * Unit tests for the retry mechanism with exponential backoff.
 *
 * These exercise the production `withRetry` contract:
 *  - retries are gated by `shouldRetry` (defaults to `isTransientNetworkError`)
 *  - the original error is re-thrown once attempts are exhausted
 *  - backoff is exponential, capped by `maxDelayMs`, with optional jitter
 */

import { withRetry, TransientError, computeJitteredDelay, type RandomSource } from './retry.js';

/**
 * Deterministic seeded PRNG (mulberry32) so jitter assertions are reproducible
 * without stubbing globals.
 */
function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Retry Mechanism', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Flushes pending microtasks and fires the retry backoff timers. */
  async function advanceRetries(times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
    }
  }

  it('should succeed on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient errors and eventually succeed', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new TransientError('transient 1'))
      .mockRejectedValueOnce(new TransientError('transient 2'))
      .mockResolvedValue('success');

    const promise = withRetry(fn);
    await advanceRetries(4);
    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts', async () => {
    const error = new TransientError('persistent');
    const fn = jest.fn().mockRejectedValue(error);

    const promise = withRetry(fn, { maxAttempts: 3 });
    await advanceRetries(4);
    await expect(promise).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-transient errors', async () => {
    const error = new Error('fatal');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should respect maxDelayMs', async () => {
    const fn = jest.fn().mockRejectedValue(new TransientError('error'));
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const promise = withRetry(fn, { maxAttempts: 5, maxDelayMs: 100 });
    await advanceRetries(6);
    await expect(promise).rejects.toThrow('error');

    const delays = setTimeoutSpy.mock.calls.map((call) => Number(call[1]) || 0);
    expect(delays.length).toBe(4);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(100);
    }
  });
});

describe('computeJitteredDelay', () => {
  it('returns the delay unchanged for the "none" strategy', () => {
    expect(computeJitteredDelay(250, { strategy: 'none' })).toBe(250);
  });

  it('varies the delay across attempts for a seeded random source', () => {
    const random = createSeededRandom(42);
    const delays = Array.from({ length: 8 }, () => computeJitteredDelay(1_000, { random }));

    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it('never exceeds the configured maximum', () => {
    const random = createSeededRandom(7);
    for (let i = 0; i < 200; i += 1) {
      const capped = computeJitteredDelay(1_000, { random, maxDelayMs: 400 });
      expect(capped).toBeLessThanOrEqual(400);
      expect(capped).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps "full" jitter within [0, base]', () => {
    const random = createSeededRandom(1234);
    for (let i = 0; i < 200; i += 1) {
      const delay = computeJitteredDelay(500, { strategy: 'full', random });
      expect(delay).toBeLessThanOrEqual(500);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps "equal" jitter within [base/2, base]', () => {
    const random = createSeededRandom(99);
    for (let i = 0; i < 200; i += 1) {
      const delay = computeJitteredDelay(500, { strategy: 'equal', random });
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });

  it('lets "decorrelated" jitter vary while staying under the cap', () => {
    const random = createSeededRandom(2024);
    const first = computeJitteredDelay(100, { strategy: 'decorrelated', random });
    const second = computeJitteredDelay(100, {
      strategy: 'decorrelated',
      random,
      previousDelayMs: first,
      maxDelayMs: 2_000,
    });

    expect(second).toBeGreaterThanOrEqual(Math.min(2_000, 100));
    expect(second).toBeLessThanOrEqual(2_000);
    expect(second).not.toBe(first);
  });

  it('falls back to full jitter when no previous delay is known', () => {
    const delay = computeJitteredDelay(800, { strategy: 'decorrelated', random: () => 0.5 });
    expect(delay).toBe(400);
  });

  it('is deterministic for a given seed', () => {
    const first = Array.from({ length: 5 }, () =>
      computeJitteredDelay(1_000, { random: createSeededRandom(11) }),
    );
    const second = Array.from({ length: 5 }, () =>
      computeJitteredDelay(1_000, { random: createSeededRandom(11) }),
    );

    expect(first).toEqual(second);
  });

  it('clamps out-of-range values from an injected random source', () => {
    expect(computeJitteredDelay(1_000, { strategy: 'full', random: () => 5 })).toBe(1_000);
    expect(computeJitteredDelay(1_000, { strategy: 'full', random: () => -3 })).toBe(0);
    expect(computeJitteredDelay(1_000, { strategy: 'full', random: () => Number.NaN })).toBe(0);
  });

  it('returns 0 for non-positive or non-finite base delays', () => {
    expect(computeJitteredDelay(0, { random: createSeededRandom(1) })).toBe(0);
    expect(computeJitteredDelay(-100, { random: createSeededRandom(1) })).toBe(0);
    expect(computeJitteredDelay(Number.NaN, { random: createSeededRandom(1) })).toBe(0);
  });

  it('honours an explicit maxDelayMs below the base delay', () => {
    const delay = computeJitteredDelay(10_000, {
      strategy: 'full',
      random: () => 1,
      maxDelayMs: 1_000,
    });
    expect(delay).toBe(1_000);
  });
});

describe('withRetry jitter integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Drives the retry loop and returns the delays it scheduled. */
  async function scheduledDelays(run: () => Promise<unknown>): Promise<number[]> {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const promise = run();

    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
    }

    await promise.catch(() => undefined);
    const delays = setTimeoutSpy.mock.calls.map((call) => Number(call[1]) || 0);
    setTimeoutSpy.mockRestore();
    return delays;
  }

  it('derives delays from the injected random source, within the cap', async () => {
    const fn = jest.fn().mockRejectedValue(new TransientError('boom'));

    const delays = await scheduledDelays(() =>
      withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 400,
        maxDelayMs: 1_000,
        jitterStrategy: 'full',
        random: () => 0.5,
      }),
    );

    // 400 * 0.5 = 200, 800 * 0.5 = 400, 1600 capped to 1000 then * 0.5 = 500
    expect(delays).toEqual([200, 400, 500]);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('varies delays between callers using a seeded random source', async () => {
    const run = async () => {
      const fn = jest.fn().mockRejectedValue(new TransientError('boom'));
      return scheduledDelays(() =>
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 1_000, jitterStrategy: 'full', random: createSeededRandom(31337) }),
      );
    };

    const [callerA, callerB] = [await run(), await run()];
    expect(callerA).toEqual(callerB); // same seed => same schedule
    expect(callerA[0]).not.toBe(callerA[1]); // varies between attempts
    const callerC = await (async () => {
      const fn = jest.fn().mockRejectedValue(new TransientError('boom'));
      return scheduledDelays(() =>
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 1_000, jitterStrategy: 'full', random: createSeededRandom(9001) }),
      );
    })();
    expect(callerC[0]).not.toBe(callerA[0]); // varies between callers
  });

  it('applies no jitter when jitter is disabled', async () => {
    const fn = jest.fn().mockRejectedValue(new TransientError('boom'));

    const delays = await scheduledDelays(() =>
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 500, jitter: false }),
    );

    expect(delays).toEqual([500, 1_000]);
  });

  it('never schedules a delay above maxDelayMs with a seeded source', async () => {
    const fn = jest.fn().mockRejectedValue(new TransientError('boom'));

    const delays = await scheduledDelays(() =>
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        jitterStrategy: 'equal',
        random: createSeededRandom(2024),
      }),
    );

    expect(delays.length).toBe(4);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(2_000);
    }
  });
});
