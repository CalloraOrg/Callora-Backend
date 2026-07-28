import { QuotaRequest, listQuotaRequests } from './quotaService.js';
import { logger } from '../logger.js';

export interface QuotasCacheEntry {
  value: QuotaRequest[];
  expiresAt: number;
}

export class QuotasCache {
  private readonly store = new Map<string, QuotasCacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): QuotaRequest[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: QuotaRequest[]): void {
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

export const quotasCache = new QuotasCache();

export interface QuotasWarmupOptions {
  timeoutMs?: number;
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
}

export interface QuotasWarmupResult {
  success: boolean;
  durationMs: number;
  entriesLoaded: number;
  reason?: string;
}

export async function warmupQuotasCache(
  options: QuotasWarmupOptions = {}
): Promise<QuotasWarmupResult> {
  const { timeoutMs = 5_000, logger: log = logger } = options;
  const started = Date.now();

  try {
    // Warm up the default query (all requests)
    const result = await Promise.race([
      listQuotaRequests(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Quotas warmup timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    quotasCache.set('all', result);

    const durationMs = Date.now() - started;
    logger.info(`[quotasCache] warmup completed in ${durationMs}ms — 1 entry loaded`);

    return { success: true, durationMs, entriesLoaded: 1 };
  } catch (err) {
    const durationMs = Date.now() - started;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`[quotasCache] warmup skipped: ${reason} (${durationMs}ms elapsed)`);

    return { success: false, durationMs, entriesLoaded: 0, reason };
  }
}
