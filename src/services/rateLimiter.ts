import type { PoolClient } from 'pg';
import type { RateLimiter, RateLimitResult } from '../types/gateway.js';
import { logger } from '../logger.js';
import {
  recordRateLimiterStoreOutage,
  recordRateLimiterStoreRecovery,
} from '../metrics.js';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterStoreCheckOptions {
  maxRequests: number;
  now: number;
  windowMs: number;
}

export interface RateLimiterStore {
  check(bucketKey: string, options: RateLimiterStoreCheckOptions): Promise<RateLimitResult>;
  /**
   * Like {@link check}, but also reports the bucket's configured `limit` and
   * the `remaining` tokens after the decision. Used by the per-API-key limiter
   * so the gateway can emit truthful `RateLimit-Limit` / `RateLimit-Remaining`
   * headers. Optional so existing custom stores remain assignable.
   */
  checkWithUsage?(
    bucketKey: string,
    options: RateLimiterStoreCheckOptions,
  ): Promise<RateLimitDecision>;
}

export interface RateLimitDecision extends RateLimitResult {
  limit: number;
  remaining: number;
}

export interface PersistentRateLimiterClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface PersistentRateLimiterPool {
  connect(): Promise<PersistentRateLimiterClient>;
}

export interface PersistentRateLimiterStoreOptions {
  tableName?: string;
}

export const PLAN_TIERS = ['free', 'pro', 'enterprise'] as const;

export type PlanTier = (typeof PLAN_TIERS)[number];

/**
 * Runtime membership test for a plan tier.
 *
 * Uses `Object.prototype.hasOwnProperty` semantics via `Array.prototype.includes`
 * over the frozen `PLAN_TIERS` list rather than the `in` operator, so a tier
 * string such as `"constructor"` or `"toString"` (which walks the prototype
 * chain and resolves to a function) is correctly rejected.
 */
export function isKnownPlanTier(tier: string): tier is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(tier);
}

export interface TierPolicy {
  maxRequests: number;
  windowMs: number;
}

export const DEFAULT_TIER_POLICIES: Record<PlanTier, TierPolicy> = {
  free:       { maxRequests: 100,  windowMs: 60_000 },
  pro:        { maxRequests: 500,  windowMs: 60_000 },
  enterprise: { maxRequests: 5000, windowMs: 60_000 },
};

export interface ConfiguredRateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  tierPolicies?: Partial<Record<PlanTier, TierPolicy>>;
}

export interface PersistentRateLimiterConfig extends ConfiguredRateLimiterOptions {
  store: 'postgres';
  tableName?: string;
}

export interface InMemoryRateLimiterConfig extends ConfiguredRateLimiterOptions {
  store?: 'memory';
}

export type RateLimiterOutageMode = 'fail-closed' | 'fallback';

export interface ResilientRateLimiterOptions {
  outageMode?: RateLimiterOutageMode;
  fallbackMaxRequests?: number;
  fallbackWindowMs?: number;
  maxFallbackBuckets?: number;
}

export type RateLimiterConfig =
  | InMemoryRateLimiterConfig
  | (PersistentRateLimiterConfig & ResilientRateLimiterOptions);

const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_PERSISTENT_TABLE = 'gateway_rate_limit_buckets';
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;

type TokenBucketRow = {
  bucket_key: string;
  tokens: number | string;
  last_refill_ms: number | string;
};

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function normalizeTokenBucketValue(
  value: number | string,
  label: string,
): number {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) {
      throw new Error(`${label} must be stored as a non-negative integer.`);
    }
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be stored as a non-negative integer.`);
  }

  return parsed;
}

function computeBucketDecision(
  bucket: TokenBucket | undefined,
  maxRequests: number,
  windowMs: number,
  now: number,
): { bucket: TokenBucket; result: RateLimitResult; limit: number; remaining: number } {
  const currentBucket = bucket
    ? { ...bucket }
    : { tokens: maxRequests, lastRefill: now };

  const elapsed = now - currentBucket.lastRefill;

  if (elapsed >= windowMs) {
    currentBucket.tokens = maxRequests;
    currentBucket.lastRefill = now;
  }

  if (currentBucket.tokens <= 0) {
    const retryAfterMs = Math.max(
      windowMs - (now - currentBucket.lastRefill),
      0,
    );

    return {
      bucket: currentBucket,
      result: { allowed: false, retryAfterMs },
      limit: maxRequests,
      remaining: 0,
    };
  }

  currentBucket.tokens -= 1;

  return {
    bucket: currentBucket,
    result: { allowed: true },
    limit: maxRequests,
    remaining: currentBucket.tokens,
  };
}

function computeRateLimitResult(
  bucket: TokenBucket | undefined,
  maxRequests: number,
  windowMs: number,
  now: number,
): { bucket: TokenBucket; result: RateLimitResult } {
  const { bucket: nextBucket, result } = computeBucketDecision(
    bucket,
    maxRequests,
    windowMs,
    now,
  );

  return { bucket: nextBucket, result };
}

function buildLimiterOptions(
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS,
): RateLimiterStoreCheckOptions {
  return {
    maxRequests: normalizePositiveInteger(maxRequests, 'maxRequests'),
    now: 0,
    windowMs: normalizePositiveInteger(windowMs, 'windowMs'),
  };
}

function assertSafeTableName(tableName: string): string {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      'Rate limiter tableName must contain only letters, numbers, and underscores.',
    );
  }

  return tableName;
}

async function rollbackQuietly(client: PersistentRateLimiterClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Ignore rollback errors so we surface the original failure.
  }
}

export class InMemoryRateLimiterStore implements RateLimiterStore {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly maxBuckets = 10_000) {
    if (!Number.isInteger(maxBuckets) || maxBuckets <= 0) {
      throw new Error('maxBuckets must be a positive integer.');
    }
  }

  async check(
    bucketKey: string,
    options: RateLimiterStoreCheckOptions,
  ): Promise<RateLimitResult> {
    const existingBucket = this.buckets.get(bucketKey);
    if (!existingBucket && this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.buckets.delete(oldestKey);
    }
    const { bucket, result } = computeRateLimitResult(
      existingBucket,
      options.maxRequests,
      options.windowMs,
      options.now,
    );

    this.buckets.set(bucketKey, bucket);
    return result;
  }

  async checkWithUsage(
    bucketKey: string,
    options: RateLimiterStoreCheckOptions,
  ): Promise<RateLimitDecision> {
    const existingBucket = this.buckets.get(bucketKey);
    if (!existingBucket && this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.buckets.delete(oldestKey);
    }
    const { bucket, result, limit, remaining } = computeBucketDecision(
      existingBucket,
      options.maxRequests,
      options.windowMs,
      options.now,
    );

    this.buckets.set(bucketKey, bucket);
    return { ...result, limit, remaining };
  }

  exhaust(bucketKey: string): void {
    this.buckets.set(bucketKey, { tokens: 0, lastRefill: Date.now() });
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Keeps a distributed limiter fail-safe when its backing store is unavailable.
 *
 * A fallback bucket is deliberately isolated from the distributed bucket: it
 * is never written back after recovery, so a recovered store cannot inherit
 * stale local counters. The local store also evicts the oldest key at a hard
 * bound to prevent an outage from turning into an unbounded memory sink.
 */
export class ResilientRateLimiterStore implements RateLimiterStore {
  private readonly fallback: InMemoryRateLimiterStore;
  private degraded = false;
  private readonly outageMode: RateLimiterOutageMode;
  private readonly fallbackMaxRequests: number;
  private readonly fallbackWindowMs: number;

  constructor(
    private readonly primary: RateLimiterStore,
    options: ResilientRateLimiterOptions = {},
  ) {
    this.outageMode = options.outageMode ?? 'fail-closed';
    this.fallbackMaxRequests = normalizePositiveInteger(
      options.fallbackMaxRequests ?? 10,
      'fallbackMaxRequests',
    );
    this.fallbackWindowMs = normalizePositiveInteger(
      options.fallbackWindowMs ?? 60_000,
      'fallbackWindowMs',
    );
    this.fallback = new InMemoryRateLimiterStore(options.maxFallbackBuckets ?? 10_000);
  }

  async check(
    bucketKey: string,
    options: RateLimiterStoreCheckOptions,
  ): Promise<RateLimitResult> {
    try {
      const result = await this.primary.check(bucketKey, options);
      if (this.degraded) {
        this.degraded = false;
        this.fallback.reset();
        recordRateLimiterStoreRecovery();
        logger.info('[rateLimiter] distributed store recovered; local fallback reset', {
          bucketKey,
        });
      }
      return result;
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        recordRateLimiterStoreOutage(this.outageMode);
        logger.error('[rateLimiter] distributed store unavailable', {
          outageMode: this.outageMode,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (this.outageMode === 'fail-closed') {
        return {
          allowed: false,
          retryAfterMs: Math.max(options.windowMs, 1_000),
        };
      }

      return this.fallback.check(bucketKey, {
        maxRequests: Math.min(options.maxRequests, this.fallbackMaxRequests),
        now: options.now,
        windowMs: Math.min(options.windowMs, this.fallbackWindowMs),
      });
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }
}

export class PostgresRateLimiterStore implements RateLimiterStore {
  private readonly pool: PersistentRateLimiterPool;
  private readonly tableName: string;
  private tableReadyPromise: Promise<void> | null = null;

  constructor(
    pool: PersistentRateLimiterPool,
    options: PersistentRateLimiterStoreOptions = {},
  ) {
    this.pool = pool;
    this.tableName = assertSafeTableName(
      options.tableName ?? DEFAULT_PERSISTENT_TABLE,
    );
  }

  async check(
    bucketKey: string,
    options: RateLimiterStoreCheckOptions,
  ): Promise<RateLimitResult> {
    await this.ensureTable();

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO ${this.tableName} (
           bucket_key,
           tokens,
           last_refill_ms
         ) VALUES ($1, $2, $3)
         ON CONFLICT (bucket_key) DO NOTHING`,
        [bucketKey, options.maxRequests, options.now],
      );

      const existingRow = await client.query<TokenBucketRow>(
        `SELECT bucket_key, tokens, last_refill_ms
         FROM ${this.tableName}
         WHERE bucket_key = $1
         FOR UPDATE`,
        [bucketKey],
      );

      if (!existingRow.rows[0]) {
        throw new Error(`Rate limiter bucket "${bucketKey}" was not found after initialization.`);
      }

      const bucket = {
        tokens: normalizeTokenBucketValue(existingRow.rows[0].tokens, 'tokens'),
        lastRefill: normalizeTokenBucketValue(
          existingRow.rows[0].last_refill_ms,
          'last_refill_ms',
        ),
      };

      const { bucket: nextBucket, result } = computeRateLimitResult(
        bucket,
        options.maxRequests,
        options.windowMs,
        options.now,
      );

      await client.query(
        `UPDATE ${this.tableName}
         SET tokens = $2,
             last_refill_ms = $3,
             updated_at = NOW()
         WHERE bucket_key = $1`,
        [bucketKey, nextBucket.tokens, nextBucket.lastRefill],
      );

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureTable(): Promise<void> {
    if (!this.tableReadyPromise) {
      this.tableReadyPromise = this.createTableIfNeeded().catch((error) => {
        this.tableReadyPromise = null;
        throw error;
      });
    }

    await this.tableReadyPromise;
  }

  private async createTableIfNeeded(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          bucket_key TEXT PRIMARY KEY,
          tokens INTEGER NOT NULL CHECK (tokens >= 0),
          last_refill_ms BIGINT NOT NULL CHECK (last_refill_ms >= 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tableName}_updated_at_idx
        ON ${this.tableName} (updated_at)
      `);
    } finally {
      client.release();
    }
  }
}

export class StoreBackedRateLimiter implements RateLimiter {
  protected readonly maxRequests: number;
  protected readonly store: RateLimiterStore;
  protected readonly windowMs: number;
  protected readonly tierPolicies: Record<PlanTier, TierPolicy>;

  constructor(
    maxRequests: number,
    windowMs: number,
    store: RateLimiterStore,
    tierPolicies?: Partial<Record<PlanTier, TierPolicy>>,
  ) {
    const baseOptions = buildLimiterOptions(maxRequests, windowMs);

    this.maxRequests = baseOptions.maxRequests;
    this.windowMs = baseOptions.windowMs;
    this.store = store;
    this.tierPolicies = {
      ...DEFAULT_TIER_POLICIES,
      ...tierPolicies,
    };
  }

  check(apiKey: string, tier?: string): Promise<RateLimitResult> {
    const policy = this.resolvePolicy(tier);
    return this.store.check(apiKey, {
      maxRequests: policy.maxRequests,
      now: Date.now(),
      windowMs: policy.windowMs,
    });
  }

  /**
   * Check the per-API-key bucket (`key:<apiKeyId>`) where the effective ceiling
   * is the smaller of the key's own `rateLimitPerMinute` and the tier policy.
   *
   * Keys only narrow: an unset (`null`/`undefined`) per-key limit leaves the
   * tier ceiling untouched, and a per-key limit above the tier is clamped down
   * to the tier. The bucket key uses the key id, never the raw key.
   */
  checkKeyLimit(
    apiKeyId: string,
    tier: string | undefined,
    rateLimitPerMinute: number | null | undefined,
  ): Promise<RateLimitDecision> {
    const policy = this.resolvePolicy(tier);
    const requested =
      typeof rateLimitPerMinute === 'number' && rateLimitPerMinute > 0
        ? rateLimitPerMinute
        : policy.maxRequests;
    const maxRequests = Math.min(requested, policy.maxRequests);

    const options: RateLimiterStoreCheckOptions = {
      maxRequests,
      now: Date.now(),
      windowMs: policy.windowMs,
    };
    const bucketKey = `key:${apiKeyId}`;

    if (this.store.checkWithUsage) {
      return this.store.checkWithUsage(bucketKey, options);
    }

    // Fallback for custom stores that do not implement `checkWithUsage`: derive
    // the decision and report the configured limit as `remaining` exactly as a
    // full bucket would after the check.
    return this.store.check(bucketKey, options).then((result) => ({
      ...result,
      limit: maxRequests,
      remaining: result.allowed ? maxRequests - 1 : 0,
    }));
  }

  resolvePolicy(tier?: string): TierPolicy {
    // `hasOwnProperty` (not the `in` operator) is required here: `in` walks the
    // prototype chain, so a tier such as "constructor" or "toString" would
    // resolve to an inherited function whose `maxRequests`/`windowMs` are
    // `undefined` and produce NaN limits that allow every request.
    if (!tier || !isKnownPlanTier(tier)) {
      if (tier) {
        console.warn(`[rateLimiter] Unknown tier "${tier}", using default`);
      }
      return { maxRequests: this.maxRequests, windowMs: this.windowMs };
    }
    return this.tierPolicies[tier];
  }
}

/**
 * Simple token-bucket rate limiter.
 * Each API key gets `maxRequests` tokens per `windowMs` window.
 */
export class InMemoryRateLimiter extends StoreBackedRateLimiter {
  private readonly inMemoryStore: InMemoryRateLimiterStore;

  constructor(
    maxRequests: number,
    windowMs: number,
    tierPolicies?: Partial<Record<PlanTier, TierPolicy>>,
  ) {
    const inMemoryStore = new InMemoryRateLimiterStore();
    super(maxRequests, windowMs, inMemoryStore, tierPolicies);
    this.inMemoryStore = inMemoryStore;
  }

  /** Helper for tests - exhaust all tokens for a given key. */
  exhaust(apiKey: string): void {
    this.inMemoryStore.exhaust(apiKey);
  }

  /** Helper for tests - reset all buckets. */
  reset(): void {
    this.inMemoryStore.reset();
  }
}

export function createRateLimiter(
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS,
  tierPolicies?: Partial<Record<PlanTier, TierPolicy>>,
): InMemoryRateLimiter {
  return new InMemoryRateLimiter(maxRequests, windowMs, tierPolicies);
}

export interface AppRateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  store: 'memory' | 'postgres';
  postgresTable: string;
  outageMode?: RateLimiterOutageMode;
  fallbackMaxRequests?: number;
  fallbackWindowMs?: number;
  maxFallbackBuckets?: number;
}

/**
 * Translates the app-level `config.rateLimiter` shape (as produced by
 * `src/config/index.ts` from RATE_LIMIT_* env vars) into the discriminated
 * `RateLimiterConfig` expected by `createConfiguredRateLimiter`. Kept as a
 * standalone pure function so the store/table wiring used by the gateway and
 * proxy routes is unit-testable without booting the full server.
 */
export function resolveRateLimiterConfig(
  config: AppRateLimiterConfig,
): RateLimiterConfig {
  if (config.store === 'postgres') {
    return {
      store: 'postgres',
      maxRequests: config.maxRequests,
      windowMs: config.windowMs,
      tableName: config.postgresTable,
      ...(config.outageMode ? { outageMode: config.outageMode } : {}),
      ...(config.fallbackMaxRequests !== undefined ? { fallbackMaxRequests: config.fallbackMaxRequests } : {}),
      ...(config.fallbackWindowMs !== undefined ? { fallbackWindowMs: config.fallbackWindowMs } : {}),
      ...(config.maxFallbackBuckets !== undefined ? { maxFallbackBuckets: config.maxFallbackBuckets } : {}),
    };
  }

  return {
    store: 'memory',
    maxRequests: config.maxRequests,
    windowMs: config.windowMs,
  };
}

export function createConfiguredRateLimiter(
  config: RateLimiterConfig,
  persistentPool?: PersistentRateLimiterPool,
): RateLimiter {
  const maxRequests = config.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const tierPolicies = config.tierPolicies;

  if (config.store === 'postgres') {
    if (!persistentPool) {
      throw new Error(
        'A PostgreSQL pool is required when RATE_LIMIT_STORE is set to "postgres".',
      );
    }

    const distributedStore = new PostgresRateLimiterStore(persistentPool, {
      tableName: config.tableName,
    });
    return new StoreBackedRateLimiter(
      maxRequests,
      windowMs,
      new ResilientRateLimiterStore(distributedStore, config),
      tierPolicies,
    );
  }

  return createRateLimiter(maxRequests, windowMs, tierPolicies);
}

export function isPersistentRateLimiterStore(
  store: RateLimiterStore,
): store is PostgresRateLimiterStore {
  return store instanceof PostgresRateLimiterStore;
}

export type RateLimiterPgClient = PoolClient;
