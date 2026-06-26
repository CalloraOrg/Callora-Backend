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

  describe('withRetry', () => {
    it('returns the result on the first successful attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const promise = withRetry(operation);
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('retries a transient failure and then succeeds', async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce(new TransientError('Transient failure'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(operation, { maxAttempts: 3 });
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('re-throws the original error after exhausting all attempts', async () => {
      const error = new TransientError('Persistent failure');
      const operation = jest.fn().mockRejectedValue(error);

      const promise = withRetry(operation, { maxAttempts: 3 });
      const assertion = expect(promise).rejects.toBe(error);
      await jest.runAllTimersAsync();
      await assertion;

      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('does not retry errors rejected by shouldRetry', async () => {
      // A plain Error is not a transient network error, so the default
      // predicate refuses to retry it.
      const error = new Error('non-transient');
      const operation = jest.fn().mockRejectedValue(error);

      const promise = withRetry(operation, { maxAttempts: 5 });
      const assertion = expect(promise).rejects.toBe(error);
      await jest.runAllTimersAsync();
      await assertion;

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('honours a custom shouldRetry predicate', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('always'));

      const promise = withRetry(operation, {
        maxAttempts: 3,
        shouldRetry: () => true,
      });
      const assertion = expect(promise).rejects.toThrow('always');
      await jest.runAllTimersAsync();
      await assertion;

      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('applies exponential backoff delays (jitter disabled)', async () => {
      const operation = jest.fn().mockRejectedValue(new TransientError('Failure'));

      const promise = withRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        jitter: false,
      });
      const assertion = expect(promise).rejects.toThrow('Failure');

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);
      expect(operation).toHaveBeenCalledTimes(1);

      // Second attempt after 1000ms (2^0 * 1000)
      await jest.advanceTimersByTimeAsync(1000);
      expect(operation).toHaveBeenCalledTimes(2);

      // Third attempt after 2000ms (2^1 * 1000)
      await jest.advanceTimersByTimeAsync(2000);
      expect(operation).toHaveBeenCalledTimes(3);

      await assertion;
    });

    it('caps the delay at maxDelayMs', async () => {
      const operation = jest.fn().mockRejectedValue(new TransientError('Failure'));

      const promise = withRetry(operation, {
        maxAttempts: 4,
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        jitter: false,
      });
      const assertion = expect(promise).rejects.toThrow('Failure');

      await jest.advanceTimersByTimeAsync(0);
      expect(operation).toHaveBeenCalledTimes(1);

      // Second attempt: 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      expect(operation).toHaveBeenCalledTimes(2);

      // Third attempt: 2000ms (2^1 * 1000)
      await jest.advanceTimersByTimeAsync(2000);
      expect(operation).toHaveBeenCalledTimes(3);

      // Fourth attempt: capped at 2000ms (would be 4000ms uncapped)
      await jest.advanceTimersByTimeAsync(2000);
      expect(operation).toHaveBeenCalledTimes(4);

      await assertion;
    });
  });

  describe('Jitter behavior', () => {
    it('keeps jittered delays within ±20% of the exponential delay', async () => {
      const operation = jest.fn().mockRejectedValue(new TransientError('Failure'));
      const delays: number[] = [];

      const originalSetTimeout = global.setTimeout;
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation(((callback: any, ms?: number) => {
          if (typeof ms === 'number' && ms > 0) delays.push(ms);
          return originalSetTimeout(callback, 0);
        }) as any);

      const promise = withRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        jitter: true,
      });
      // Attach the rejection handler synchronously so the promise never rejects
      // unhandled while the fake timers drain.
      const settled = promise.catch(() => {});

      await jest.runAllTimersAsync();
      await settled;

      expect(delays.length).toBe(2); // two retries
      // First retry: 1000 * (0.8 .. 1.2)
      expect(delays[0]).toBeGreaterThanOrEqual(800);
      expect(delays[0]).toBeLessThanOrEqual(1200);
    });
  });
});
