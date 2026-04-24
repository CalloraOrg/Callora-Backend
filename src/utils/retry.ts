/**
 * Exponential backoff with full jitter for transient Stellar
 * Horizon / Soroban RPC failures.
 *
 * Only retries errors classified as transient. Non-retryable errors (4xx
 * besides 429, malformed XDR, signature failures) short-circuit so we don't
 * resubmit invalid requests.
 */

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULTS: Required<
  Omit<RetryOptions, 'shouldRetry' | 'onRetry' | 'sleep' | 'random'>
> = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 8_000,
  backoffFactor: 2,
};

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
]);

const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Soroban RPC / Horizon semantic transients. `TRY_AGAIN_LATER` is the RPC's
// explicit retry signal. `NOT_FOUND` shows up while polling `getTransaction`
// until the ledger closes — callers retrying poll loops should allow it.
const TRANSIENT_SOROBAN_STATUS = new Set([
  'TRY_AGAIN_LATER',
  'PENDING',
  'NOT_FOUND',
  'DUPLICATE',
]);

export function isTransientError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;

    const code = typeof e.code === 'string' ? e.code : undefined;
    if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;

    const status = extractStatus(e);
    if (status !== undefined && TRANSIENT_HTTP_STATUS.has(status)) return true;

    const sorobanStatus = typeof e.status === 'string' ? e.status : undefined;
    if (sorobanStatus && TRANSIENT_SOROBAN_STATUS.has(sorobanStatus)) {
      return true;
    }

    if (e.name === 'NetworkError') return true;

    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes('socket hang up') ||
        msg.includes('network timeout') ||
        msg.includes('request timed out') ||
        msg.includes('try_again_later')
      ) {
        return true;
      }
    }
  }

  return false;
}

function extractStatus(e: Record<string, unknown>): number | undefined {
  const candidates = [
    e.status,
    e.statusCode,
    (e.response as Record<string, unknown> | undefined)?.status,
    (e.response as Record<string, unknown> | undefined)?.statusCode,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const initialDelay = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const maxDelay = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const factor = options.backoffFactor ?? DEFAULTS.backoffFactor;
  const shouldRetry = options.shouldRetry ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  if (maxAttempts < 1) throw new Error('maxAttempts must be >= 1');

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts;
      if (isLast || !shouldRetry(err, attempt)) throw err;

      const cap = Math.min(maxDelay, initialDelay * factor ** (attempt - 1));
      const delay = Math.floor(random() * cap);
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }

  // unreachable — loop either returns or throws
  throw lastErr;
}
