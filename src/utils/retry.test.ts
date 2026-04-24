import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withRetry, isTransientError } from './retry.js';

describe('isTransientError', () => {
  it('classifies network ECONNRESET as transient', () => {
    assert.strictEqual(isTransientError({ code: 'ECONNRESET' }), true);
  });

  it('classifies HTTP 503 as transient', () => {
    assert.strictEqual(isTransientError({ status: 503 }), true);
  });

  it('classifies HTTP 429 (rate limit) as transient', () => {
    assert.strictEqual(isTransientError({ statusCode: 429 }), true);
  });

  it('classifies axios-style nested response 504 as transient', () => {
    assert.strictEqual(isTransientError({ response: { status: 504 } }), true);
  });

  it('classifies Soroban TRY_AGAIN_LATER status as transient', () => {
    assert.strictEqual(isTransientError({ status: 'TRY_AGAIN_LATER' }), true);
  });

  it('classifies Soroban NOT_FOUND status as transient (poll loop)', () => {
    assert.strictEqual(isTransientError({ status: 'NOT_FOUND' }), true);
  });

  it('classifies "socket hang up" Error message as transient', () => {
    assert.strictEqual(isTransientError(new Error('socket hang up')), true);
  });

  it('does NOT classify 400 as transient', () => {
    assert.strictEqual(isTransientError({ status: 400 }), false);
  });

  it('does NOT classify 404 as transient', () => {
    assert.strictEqual(isTransientError({ status: 404 }), false);
  });

  it('does NOT classify validation Error as transient', () => {
    assert.strictEqual(
      isTransientError(new Error('invalid signature')),
      false
    );
  });

  it('does NOT classify null/undefined as transient', () => {
    assert.strictEqual(isTransientError(null), false);
    assert.strictEqual(isTransientError(undefined), false);
  });
});

describe('withRetry', () => {
  const noSleep = (): Promise<void> => Promise.resolve();
  const fixedRandom = (): number => 0.5;

  it('returns immediately on success without retry', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { sleep: noSleep, random: fixedRandom }
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
  });

  it('retries transient errors up to maxAttempts and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const e = new Error('boom');
          (e as Error & { code: string }).code = 'ETIMEDOUT';
          throw e;
        }
        return 'ok';
      },
      { sleep: noSleep, random: fixedRandom, maxAttempts: 5 }
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 3);
  });

  it('throws non-transient error immediately', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          const e = new Error('bad request') as Error & { status: number };
          e.status = 400;
          throw e;
        },
        { sleep: noSleep, random: fixedRandom }
      ),
      /bad request/
    );
    assert.strictEqual(calls, 1);
  });

  it('throws last error after exhausting maxAttempts', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          const e = new Error(`boom-${calls}`) as Error & { code: string };
          e.code = 'ECONNRESET';
          throw e;
        },
        { sleep: noSleep, random: fixedRandom, maxAttempts: 3 }
      ),
      /boom-3/
    );
    assert.strictEqual(calls, 3);
  });

  it('honors custom shouldRetry predicate', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('always-fatal');
        },
        {
          sleep: noSleep,
          random: fixedRandom,
          maxAttempts: 5,
          shouldRetry: () => false,
        }
      ),
      /always-fatal/
    );
    assert.strictEqual(calls, 1);
  });

  it('applies exponential backoff bounded by maxDelayMs (full jitter)', async () => {
    const delays: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          const e = new Error('boom') as Error & { code: string };
          e.code = 'ETIMEDOUT';
          throw e;
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
          random: () => 1, // upper bound of jitter window
          maxAttempts: 5,
          initialDelayMs: 100,
          maxDelayMs: 800,
          backoffFactor: 2,
        }
      )
    );
    // Expected caps: 100, 200, 400, 800 (last attempt does not sleep).
    // random() === 1 returns floor(cap * 1) - tiny epsilon = cap - 1 for our floor logic.
    // We assert non-decreasing growth and final cap honored.
    assert.strictEqual(delays.length, 4);
    assert.ok(delays[0] < delays[1]);
    assert.ok(delays[1] < delays[2]);
    assert.ok(delays[3] <= 800);
  });

  it('invokes onRetry callback with attempt number and delay', async () => {
    const events: Array<{ attempt: number; delay: number }> = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) {
          const e = new Error('boom') as Error & { code: string };
          e.code = 'ECONNRESET';
          throw e;
        }
        return 'ok';
      },
      {
        sleep: noSleep,
        random: fixedRandom,
        onRetry: (_err, attempt, delay) => {
          events.push({ attempt, delay });
        },
      }
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].attempt, 1);
  });

  it('rejects maxAttempts < 1', async () => {
    await assert.rejects(
      withRetry(async () => 'ok', { maxAttempts: 0 }),
      /maxAttempts must be >= 1/
    );
  });
});
