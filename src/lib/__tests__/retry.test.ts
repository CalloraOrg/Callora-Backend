import assert from 'node:assert/strict';
import { withRetry, isTransientNetworkError, TransientError, RETRIABLE_HTTP_STATUSES } from '../retry.js';

describe('RETRIABLE_HTTP_STATUSES', () => {
  test('includes 429, 500, 502, 503, 504', () => {
    expect(RETRIABLE_HTTP_STATUSES.has(429)).toBe(true);
    expect(RETRIABLE_HTTP_STATUSES.has(500)).toBe(true);
    expect(RETRIABLE_HTTP_STATUSES.has(502)).toBe(true);
    expect(RETRIABLE_HTTP_STATUSES.has(503)).toBe(true);
    expect(RETRIABLE_HTTP_STATUSES.has(504)).toBe(true);
  });

  test('excludes 400, 401, 403, 404', () => {
    expect(RETRIABLE_HTTP_STATUSES.has(400)).toBe(false);
    expect(RETRIABLE_HTTP_STATUSES.has(401)).toBe(false);
    expect(RETRIABLE_HTTP_STATUSES.has(403)).toBe(false);
    expect(RETRIABLE_HTTP_STATUSES.has(404)).toBe(false);
  });
});

describe('isTransientNetworkError', () => {
  test('returns true for TransientError', () => {
    assert.equal(isTransientNetworkError(new TransientError('HTTP 503')), true);
  });

  test('returns false for AbortError (self-imposed timeout)', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    assert.equal(isTransientNetworkError(abort), false);
  });

  test('returns true for TypeError with econnrefused', () => {
    assert.equal(isTransientNetworkError(new TypeError('connect ECONNREFUSED 127.0.0.1:8080')), true);
  });

  test('returns true for TypeError with fetch failed', () => {
    assert.equal(isTransientNetworkError(new TypeError('fetch failed')), true);
  });

  test('returns true for TypeError with socket hang up', () => {
    assert.equal(isTransientNetworkError(new TypeError('socket hang up')), true);
  });

  test('returns false for generic Error', () => {
    assert.equal(isTransientNetworkError(new Error('something broke')), false);
  });

  test('returns false for non-Error values', () => {
    assert.equal(isTransientNetworkError('network error'), false);
    assert.equal(isTransientNetworkError(null), false);
    assert.equal(isTransientNetworkError(undefined), false);
  });
});

describe('withRetry', () => {
  test('returns the result immediately on success', async () => {
    const result = await withRetry(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  test('retries on TransientError and returns result on second attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new TransientError('HTTP 503'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 0, jitter: false });
    assert.equal(result, 'ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on transient TypeError and returns result on second attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('recovered');

    const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 0, jitter: false });
    assert.equal(result, 'recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('does NOT retry on non-transient Error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('bad input'));

    await assert.rejects(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 0, jitter: false }),
      /bad input/
    );
    // Throws immediately — no retries
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry on AbortError', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fn = jest.fn().mockRejectedValue(abort);

    await assert.rejects(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 0, jitter: false }),
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('exhausts all attempts and throws the last error', async () => {
    const err = new TransientError('still down');
    const fn = jest.fn().mockRejectedValue(err);

    await assert.rejects(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, jitter: false }),
      (thrown) => thrown === err
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('respects custom shouldRetry predicate', async () => {
    const sentinel = new Error('retryable-custom');
    const fn = jest.fn()
      .mockRejectedValueOnce(sentinel)
      .mockResolvedValueOnce('custom-ok');

    const result = await withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 0,
      jitter: false,
      shouldRetry: (e) => e === sentinel,
    });
    assert.equal(result, 'custom-ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('applies exponential backoff between retries', async () => {
    jest.useFakeTimers();

    const fn = jest.fn()
      .mockRejectedValueOnce(new TransientError('a'))
      .mockRejectedValueOnce(new TransientError('b'))
      .mockResolvedValueOnce('done');

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, jitter: false });

    // Advance through first delay (100ms) then second (200ms)
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    const result = await promise;
    assert.equal(result, 'done');
    expect(fn).toHaveBeenCalledTimes(3);

    jest.useRealTimers();
  });
});
