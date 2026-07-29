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

export interface RetryOptions {
  /** Total attempts including the first. Default: 4 (3 retries). */
  maxAttempts?: number;
  /** Initial delay in ms; doubles each retry. Default: 500. */
  baseDelayMs?: number;
  /** Upper bound on computed delay before jitter. Default: 10_000. */
  maxDelayMs?: number;
  /** Apply ±20% jitter to prevent thundering herd. Default: true. */
  jitter?: boolean;
  /** Override the transient-error predicate. Default: isTransientNetworkError. */
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const jitter = options.jitter ?? true;
  const shouldRetry = options.shouldRetry ?? isTransientNetworkError;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts - 1 || !shouldRetry(error)) throw error;
      const exponential = baseDelayMs * 2 ** attempt;
      const capped = Math.min(exponential, maxDelayMs);
      const factor = jitter ? 0.8 + Math.random() * 0.4 : 1;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.round(capped * factor)));
    }
  }
}
