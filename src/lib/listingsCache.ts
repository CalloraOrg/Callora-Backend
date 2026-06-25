/**
 * src/lib/listingsCache.ts
 *
 * Short-TTL in-process cache for GET /api/apis marketplace listings.
 *
 * Design decisions
 * ────────────────
 * • Keyed by serialised query params (category, search, limit, offset) so
 *   different filter combinations are cached independently.
 * • Partial invalidation: create/update operations call `invalidateAll()`
 *   because any new or updated API may appear in any filter combination.
 *   A full flush is safe here — the TTL is short (default 30 s) and writes
 *   are infrequent compared to reads.
 * • No external dependency: plain Map + setTimeout so the cache works in
 *   every environment (test, dev, prod) without Redis or any other service.
 * • The cache is exported as a singleton (`listingsCache`) so the route and
 *   repository share the same instance.  Tests can swap it via dependency
 *   injection or call `listingsCache.clear()` in `beforeEach`.
 *
 * Security notes
 * ──────────────
 * • Cache keys are derived from validated, low-cardinality query params only
 *   (category, search, limit, offset).  Raw request URLs are never used as
 *   keys to prevent cache-key injection via crafted query strings.
 * • Cached values are plain serialisable objects — no user-specific data is
 *   stored, so there is no risk of cross-user data leakage.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ListingsCacheEntry<T> {
  value: T;
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt: number;
}

export interface ListingsCacheOptions {
  /** Time-to-live in milliseconds. Defaults to 30 000 (30 s). */
  ttlMs?: number;
}

export interface ListingsCacheKeyParams {
  limit: number;
  offset: number;
  category?: string;
  search?: string;
}

// ── Cache key builder ─────────────────────────────────────────────────────────

/**
 * Build a stable, deterministic cache key from listing query params.
 *
 * Only the four params that affect the result set are included.
 * The key is a compact JSON string so it is human-readable in logs.
 */
export function buildCacheKey(params: ListingsCacheKeyParams): string {
  return JSON.stringify({
    limit: params.limit,
    offset: params.offset,
    category: params.category ?? null,
    search: params.search ?? null,
  });
}

// ── Cache class ───────────────────────────────────────────────────────────────

export class ListingsCache<T = unknown> {
  private readonly store = new Map<string, ListingsCacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(options: ListingsCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  /**
   * Return the cached value for `key`, or `undefined` if absent / expired.
   * Expired entries are lazily evicted on read.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      // Lazy eviction — remove stale entry and report a miss.
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Store `value` under `key` with the configured TTL.
   * Any existing entry for the same key is overwritten.
   */
  set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Remove a single entry by key.
   * No-op if the key is not present.
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Flush all entries.
   *
   * Called by the repository after every create/update so that the next
   * listing read reflects the latest data.  Because any write may affect
   * any filter combination, a full flush is simpler and safer than
   * attempting partial invalidation.
   */
  invalidateAll(): void {
    this.store.clear();
  }

  /** Alias for `invalidateAll` — used in tests for clarity. */
  clear(): void {
    this.store.clear();
  }

  /** Number of live (possibly expired) entries currently in the store. */
  get size(): number {
    return this.store.size;
  }

  /** Expose TTL for introspection / testing. */
  get ttl(): number {
    return this.ttlMs;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Shared cache instance used by the APIs route and repository.
 *
 * TTL is 30 s by default.  Override via the APIS_CACHE_TTL_MS environment
 * variable (parsed at module load time) for environment-specific tuning
 * without code changes.
 */
const envTtl = Number(process.env.APIS_CACHE_TTL_MS);
export const listingsCache = new ListingsCache({
  ttlMs: Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 30_000,
});

// ── Warmup ────────────────────────────────────────────────────────────────────

export interface WarmupOptions {
  /** Maximum time in ms to wait for the warmup query. Default: 5 000. */
  timeoutMs?: number;
  /** Logger interface — defaults to console. */
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
}

export interface WarmupResult {
  success: boolean;
  durationMs: number;
  entriesLoaded: number;
  reason?: string;
}

/**
 * Prime the listings cache from the repository before the HTTP server starts.
 *
 * Design decisions
 * ────────────────
 * • Time-bounded: a configurable timeout prevents a slow DB from blocking boot.
 * • Fail-open: any error (DB unreachable, timeout) is logged and boot continues.
 * • Default params: seeds the most common page (limit=20, offset=0) so the
 *   majority of first-hit requests are served from cache after deploy.
 *
 * Security notes
 * ──────────────
 * • Only calls `listPublic` — no privileged data is loaded into the cache.
 * • Cache keys are built with `buildCacheKey` — same validated params as
 *   live requests, preventing any cache-key injection at warmup time.
 *
 * @param cache    The ListingsCache instance to prime.
 * @param listPublic  Function that fetches the public listing (mirrors repository.listPublic).
 * @param options  Timeout and logger overrides.
 */
export async function warmupListingsCache<T>(
  cache: ListingsCache<T>,
  listPublic: (params: ListingsCacheKeyParams) => Promise<T>,
  options: WarmupOptions = {},
): Promise<WarmupResult> {
  const { timeoutMs = 5_000, logger = console } = options;
  const started = Date.now();

  const defaultParams: ListingsCacheKeyParams = { limit: 20, offset: 0 };

  try {
    const result = await Promise.race([
      listPublic(defaultParams),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Warmup timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const key = buildCacheKey(defaultParams);
    cache.set(key, result);

    const durationMs = Date.now() - started;
    logger.log(`[listingsCache] warmup completed in ${durationMs}ms — 1 entry loaded`);

    return { success: true, durationMs, entriesLoaded: 1 };
  } catch (err) {
    const durationMs = Date.now() - started;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`[listingsCache] warmup skipped: ${reason} (${durationMs}ms elapsed)`);

    return { success: false, durationMs, entriesLoaded: 0, reason };
  }
}
