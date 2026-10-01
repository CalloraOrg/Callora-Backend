/** HTTP status codes that indicate a transient server-side condition worth retrying. */
export const RETRIABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'fetch failed',
  'failed to fetch',
  'socket hang up',
  'und_err_connect_timeout',
  'und_err_socket',
];

/** Signals a retriable HTTP-level failure from within a retry scope. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

/**
 * Returns true for errors representing a transient network condition.
 * AbortError (self-imposed request timeout) is NOT retriable — the server
 * was already unresponsive; retrying immediately makes things worse.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof TypeError) {
    const msg = error.message.toLowerCase();
    return TRANSIENT_MESSAGE_FRAGMENTS.some((f) => msg.includes(f));
  }
  return false;
}

/** Random source producing a value in [0, 1). Injectable so tests stay deterministic. */
export type RandomSource = () => number;

/**
 * Jitter strategies for backoff delays.
 *
 * - `none` — no jitter, the delay is used verbatim.
 * - `full` — uniform over `[0, cap]`; spreads callers the most.
 * - `equal` — uniform over `[cap/2, cap]`; keeps a minimum backoff while
 *   still de-synchronising callers.
 * - `decorrelated` — uniform over `[min(base, prev*3), min(cap, prev*3)]`;
 *   randomised, but still grows when a caller keeps failing.
 */
export type JitterStrategy = 'none' | 'full' | 'equal' | 'decorrelated';

export interface JitterOptions {
  /** Strategy to apply. Default: `full`. */
  strategy?: JitterStrategy;
  /** Random source in [0, 1). Default: `Math.random`. */
  random?: RandomSource;
  /** Hard upper bound for the returned delay. Default: `baseDelayMs`. */
  maxDelayMs?: number;
  /** Previous jittered delay; only used by the `decorrelated` strategy. */
  previousDelayMs?: number;
}

/** Clamp an injected random value into the [0, 1] interval. */
function unitInterval(random: RandomSource): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Computes a randomised backoff delay that is always within
 * `[0, min(baseDelayMs, maxDelayMs ?? baseDelayMs)]`.
 *
 * Without jitter every caller that failed at the same moment retries in
 * lockstep, which is exactly the thundering herd that can re-trigger an
 * outage while a dependency is recovering. Randomising the delay while
 * keeping a hard upper bound keeps retries spread out without letting a
 * single caller's delay grow past its configured ceiling.
 */
export function computeJitteredDelay(
  baseDelayMs: number,
  options: JitterOptions = {},
): number {
  const strategy = options.strategy ?? 'full';

  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) return 0;

  const cap = Math.max(
    0,
    Math.min(baseDelayMs, options.maxDelayMs ?? baseDelayMs),
  );
  if (cap === 0) return 0;

  if (strategy === 'none') return Math.round(cap);

  const unit = unitInterval(options.random ?? Math.random);

  let delay: number;
  switch (strategy) {
    case 'equal':
      delay = cap / 2 + unit * (cap / 2);
      break;
    case 'decorrelated': {
      const previous = options.previousDelayMs;
      if (previous === undefined || !Number.isFinite(previous) || previous < 0) {
        delay = unit * cap;
        break;
      }
      const lowerBound = Math.min(cap, baseDelayMs);
      const upperBound = Math.min(cap, Math.max(previous * 3, lowerBound));
      delay = lowerBound + unit * (upperBound - lowerBound);
      break;
    }
    case 'full':
    default:
      delay = unit * cap;
      break;
  }

  return Math.min(cap, Math.max(0, Math.round(delay)));
}

export interface RetryOptions {
  /** Total attempts including the first. Default: 4 (3 retries). */
  maxAttempts?: number;
  /** Initial delay in ms; doubles each retry. Default: 500. */
  baseDelayMs?: number;
  /** Upper bound on the computed delay; jitter never exceeds it. Default: 10_000. */
  maxDelayMs?: number;
  /** Apply jitter to prevent thundering herd. Default: true. */
  jitter?: boolean;
  /** Jitter strategy used when `jitter` is enabled. Default: `equal`. */
  jitterStrategy?: JitterStrategy;
  /** Random source in [0, 1); inject a seeded source for deterministic tests. */
  random?: RandomSource;
  /** Override the transient-error predicate. Default: isTransientNetworkError. */
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const jitter = options.jitter ?? true;
  const shouldRetry = options.shouldRetry ?? isTransientNetworkError;
  const strategy = jitter ? (options.jitterStrategy ?? 'equal') : 'none';

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts - 1 || !shouldRetry(error)) throw error;
      const exponential = baseDelayMs * 2 ** attempt;
      const delay = computeJitteredDelay(exponential, {
        strategy,
        random: options.random,
        maxDelayMs,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
