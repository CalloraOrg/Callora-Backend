import type { PoolClient } from 'pg';
import type { RateLimiter, RateLimitResult } from '../types/gateway.js';

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

export type PlanTier = 'free' | 'pro' | 'enterprise';

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

export type RateLimiterConfig =
  | InMemoryRateLimiterConfig
  | PersistentRateLimiterConfig;

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

function computeRateLimitResult(
  bucket: TokenBucket | undefined,
  maxRequests: number,
  windowMs: number,
  now: number,
): { bucket: TokenBucket; result: RateLimitResult } {
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
    };
  }

  currentBucket.tokens -= 1;

  return {
    bucket: currentBucket,
    result: { allowed: true },
  };
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

  async check(
    bucketKey: string,
    options: RateLimiterStoreCheckOptions,
  ): Promise<RateLimitResult> {
    const existingBucket = this.buckets.get(bucketKey);
    const { bucket, result } = computeRateLimitResult(
      existingBucket,
      options.maxRequests,
      options.windowMs,
      options.now,
    );

    this.buckets.set(bucketKey, bucket);
    return result;
  }

  exhaust(bucketKey: string): void {
    this.buckets.set(bucketKey, { tokens: 0, lastRefill: Date.now() });
  }

  reset(): void {
    this.buckets.clear();
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

  private resolvePolicy(tier?: string): TierPolicy {
    if (!tier || !(tier in this.tierPolicies)) {
      if (tier) {
        console.warn(`[rateLimiter] Unknown tier "${tier}", using default`);
      }
      return { maxRequests: this.maxRequests, windowMs: this.windowMs };
    }
    return this.tierPolicies[tier as PlanTier]!;
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

    return new StoreBackedRateLimiter(
      maxRequests,
      windowMs,
      new PostgresRateLimiterStore(persistentPool, {
        tableName: config.tableName,
      }),
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
