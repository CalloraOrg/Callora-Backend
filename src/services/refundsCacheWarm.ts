import { defaultDisputeService } from './disputeService.js';
import { logger } from '../logger.js';

export interface RefundsCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class RefundsCache<T = unknown> {
  private readonly store = new Map<string, RefundsCacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidateAll(): void {
    this.store.clear();
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export const refundsCache = new RefundsCache();

export interface RefundsWarmupOptions {
  timeoutMs?: number;
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
}

export interface RefundsWarmupResult {
  success: boolean;
  durationMs: number;
  entriesLoaded: number;
  reason?: string;
}

export async function warmupRefundsCache(
  options: RefundsWarmupOptions = {}
): Promise<RefundsWarmupResult> {
  const { timeoutMs = 5_000, logger: log = logger } = options;
  const started = Date.now();

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        const all = defaultDisputeService.listAll();
        return all.filter((d) => d.status === 'REFUNDED');
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Refunds warmup timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    refundsCache.set('all', result);

    const durationMs = Date.now() - started;
    logger.info(`[refundsCache] warmup completed in ${durationMs}ms — 1 entry loaded`);

    return { success: true, durationMs, entriesLoaded: 1 };
  } catch (err) {
    const durationMs = Date.now() - started;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`[refundsCache] warmup skipped: ${reason} (${durationMs}ms elapsed)`);

    return { success: false, durationMs, entriesLoaded: 0, reason };
  }
}
