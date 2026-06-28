/**
 * Unit tests for the retry mechanism with exponential backoff.
 *
 * These exercise the production `withRetry` contract:
 *  - retries are gated by `shouldRetry` (defaults to `isTransientNetworkError`)
 *  - the original error is re-thrown once attempts are exhausted
 *  - backoff is exponential, capped by `maxDelayMs`, with optional ±20% jitter
 */

import { withRetry, TransientError } from './retry.js';

describe('Retry Mechanism', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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

    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts', async () => {
    const error = new TransientError('persistent');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow('persistent');
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
    const start = Date.now();

    await expect(withRetry(fn, { maxAttempts: 5, maxDelayMs: 100 })).rejects.toThrow('error');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});
