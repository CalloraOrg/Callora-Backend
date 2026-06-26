/**
 * Circuit Breaker pattern implementation for protecting against cascading failures.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Fast-fail mode, requests immediately rejected
 * - HALF_OPEN: Testing recovery, single probe request allowed
 * 
 * Configuration:
 * - failureThreshold: Consecutive failures before opening (default: 5)
 * - cooldownMs: Time in OPEN state before attempting recovery (default: 30000)
 * - successThreshold: Consecutive successes in HALF_OPEN to close (default: 1)
 */

import { CircuitBreakerOpenError } from './errors.js';
import type { PersistentRateLimiterPool } from '../services/rateLimiter.js';

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  cooldownMs?: number;
  successThreshold?: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: number | null;
  lastStateChange: number;
}

export interface CircuitBreakerStore {
  get(breakerKey: string): Promise<CircuitBreakerMetrics | null>;
  set(breakerKey: string, metrics: CircuitBreakerMetrics): Promise<void>;
}

export class InMemoryCircuitBreakerStore implements CircuitBreakerStore {
  private readonly store = new Map<string, CircuitBreakerMetrics>();

  async get(breakerKey: string): Promise<CircuitBreakerMetrics | null> {
    return this.store.get(breakerKey) || null;
  }

  async set(breakerKey: string, metrics: CircuitBreakerMetrics): Promise<void> {
    this.store.set(breakerKey, metrics);
  }

  reset(): void {
    this.store.clear();
  }
}

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  cooldownMs: 30000,
  successThreshold: 1,
};

const DEFAULT_PERSISTENT_TABLE = 'gateway_circuit_breakers';
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;

function assertSafeTableName(tableName: string): string {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      'Circuit breaker tableName must contain only letters, numbers, and underscores.',
    );
  }
  return tableName;
}

async function rollbackQuietly(client: { query: (text: string) => Promise<unknown>; release: () => void }): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Ignore rollback errors so we surface the original failure.
  }
}

export class PostgresCircuitBreakerStore implements CircuitBreakerStore {
  private readonly pool: PersistentRateLimiterPool;
  private readonly tableName: string;
  private tableReadyPromise: Promise<void> | null = null;

  constructor(
    pool: PersistentRateLimiterPool,
    options: { tableName?: string } = {},
  ) {
    this.pool = pool;
    this.tableName = assertSafeTableName(
      options.tableName ?? DEFAULT_PERSISTENT_TABLE,
    );
  }

  async get(breakerKey: string): Promise<CircuitBreakerMetrics | null> {
    await this.ensureTable();
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        breaker_key: string;
        state: string;
        consecutive_failures: number;
        consecutive_successes: number;
        total_failures: number;
        total_successes: number;
        last_failure_time: number | null;
        last_state_change: number;
      }>(
        `SELECT breaker_key, state, consecutive_failures, consecutive_successes, total_failures, total_successes, last_failure_time, last_state_change
         FROM ${this.tableName}
         WHERE breaker_key = $1`,
        [breakerKey],
      );
      if (!result.rows[0]) {
        return null;
      }
      const row = result.rows[0];
      return {
        state: row.state as CircuitBreakerState,
        consecutiveFailures: row.consecutive_failures,
        consecutiveSuccesses: row.consecutive_successes,
        totalFailures: row.total_failures,
        totalSuccesses: row.total_successes,
        lastFailureTime: row.last_failure_time,
        lastStateChange: row.last_state_change,
      };
    } finally {
      client.release();
    }
  }

  async set(breakerKey: string, metrics: CircuitBreakerMetrics): Promise<void> {
    await this.ensureTable();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${this.tableName} (
           breaker_key,
           state,
           consecutive_failures,
           consecutive_successes,
           total_failures,
           total_successes,
           last_failure_time,
           last_state_change
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (breaker_key) DO UPDATE SET
           state = EXCLUDED.state,
           consecutive_failures = EXCLUDED.consecutive_failures,
           consecutive_successes = EXCLUDED.consecutive_successes,
           total_failures = EXCLUDED.total_failures,
           total_successes = EXCLUDED.total_successes,
           last_failure_time = EXCLUDED.last_failure_time,
           last_state_change = EXCLUDED.last_state_change,
           updated_at = NOW()`,
        [
          breakerKey,
          metrics.state,
          metrics.consecutiveFailures,
          metrics.consecutiveSuccesses,
          metrics.totalFailures,
          metrics.totalSuccesses,
          metrics.lastFailureTime,
          metrics.lastStateChange,
        ],
      );
      await client.query('COMMIT');
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
          breaker_key TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
          consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
          consecutive_successes INTEGER NOT NULL CHECK (consecutive_successes >= 0),
          total_failures INTEGER NOT NULL CHECK (total_failures >= 0),
          total_successes INTEGER NOT NULL CHECK (total_successes >= 0),
          last_failure_time BIGINT,
          last_state_change BIGINT NOT NULL CHECK (last_state_change >= 0),
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

const DEFAULT_METRICS: CircuitBreakerMetrics = {
  state: CircuitBreakerState.CLOSED,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  totalFailures: 0,
  totalSuccesses: 0,
  lastFailureTime: null,
  lastStateChange: Date.now(),
};

/**
 * Circuit Breaker implementation with automatic state management and persistent storage.
 */
export class CircuitBreaker {
  private readonly store: CircuitBreakerStore;
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig = {}, store?: CircuitBreakerStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store || new InMemoryCircuitBreakerStore();
  }

  /**
   * Execute an operation through the circuit breaker.
   * 
   * @param breakerKey - Unique key to identify this circuit breaker instance
   * @param operation - Async function to execute
   * @returns Result of the operation
   * @throws CircuitBreakerOpenError if circuit is open
   */
  async execute<T>(breakerKey: string, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    let metrics = (await this.store.get(breakerKey)) || { ...DEFAULT_METRICS };

    // Check if we should transition from OPEN to HALF_OPEN
    if (metrics.state === CircuitBreakerState.OPEN) {
      const timeSinceFailure = now - (metrics.lastFailureTime ?? 0);
      if (timeSinceFailure >= this.config.cooldownMs) {
        metrics = this.transitionTo(metrics, CircuitBreakerState.HALF_OPEN, now);
      } else {
        throw new CircuitBreakerOpenError(
          `Circuit breaker is open. Cooldown remaining: ${
            this.config.cooldownMs - timeSinceFailure
          }ms`
        );
      }
    }

    try {
      const result = await operation();
      metrics = this.onSuccess(metrics, now);
      await this.store.set(breakerKey, metrics);
      return result;
    } catch (error) {
      metrics = this.onFailure(metrics, now);
      await this.store.set(breakerKey, metrics);
      throw error;
    }
  }

  /**
   * Handle successful operation execution.
   */
  private onSuccess(metrics: CircuitBreakerMetrics, now: number): CircuitBreakerMetrics {
    const nextMetrics = {
      ...metrics,
      totalSuccesses: metrics.totalSuccesses + 1,
      consecutiveFailures: 0,
      consecutiveSuccesses: metrics.consecutiveSuccesses + 1,
    };

    if (nextMetrics.state === CircuitBreakerState.HALF_OPEN) {
      if (nextMetrics.consecutiveSuccesses >= this.config.successThreshold) {
        return this.transitionTo({ ...nextMetrics, consecutiveSuccesses: 0 }, CircuitBreakerState.CLOSED, now);
      }
    }

    return nextMetrics;
  }

  /**
   * Handle failed operation execution.
   */
  private onFailure(metrics: CircuitBreakerMetrics, now: number): CircuitBreakerMetrics {
    const nextMetrics = {
      ...metrics,
      totalFailures: metrics.totalFailures + 1,
      consecutiveSuccesses: 0,
      consecutiveFailures: metrics.consecutiveFailures + 1,
      lastFailureTime: now,
    };

    if (nextMetrics.state === CircuitBreakerState.HALF_OPEN) {
      // Immediate transition back to OPEN on any failure in HALF_OPEN
      return this.transitionTo(nextMetrics, CircuitBreakerState.OPEN, now);
    } else if (nextMetrics.state === CircuitBreakerState.CLOSED) {
      if (nextMetrics.consecutiveFailures >= this.config.failureThreshold) {
        return this.transitionTo(nextMetrics, CircuitBreakerState.OPEN, now);
      }
    }

    return nextMetrics;
  }

  /**
   * Transition to a new circuit breaker state.
   */
  private transitionTo(metrics: CircuitBreakerMetrics, newState: CircuitBreakerState, now: number): CircuitBreakerMetrics {
    const oldState = metrics.state;
    const nextMetrics = {
      ...metrics,
      state: newState,
      lastStateChange: now,
    };

    console.log(
      `Circuit breaker state transition: ${oldState} → ${newState} ` +
      `(failures: ${nextMetrics.consecutiveFailures}, successes: ${nextMetrics.consecutiveSuccesses})`
    );

    // Reset consecutive counters on state change to CLOSED
    if (newState === CircuitBreakerState.CLOSED) {
      return { ...nextMetrics, consecutiveFailures: 0 };
    }

    return nextMetrics;
  }

  /**
   * Get current circuit breaker metrics.
   */
  async getMetrics(breakerKey: string): Promise<CircuitBreakerMetrics> {
    return (await this.store.get(breakerKey)) || { ...DEFAULT_METRICS };
  }

  /**
   * Get current state.
   */
  async getState(breakerKey: string): Promise<CircuitBreakerState> {
    const metrics = await this.getMetrics(breakerKey);
    return metrics.state;
  }

  /**
   * Force reset the circuit breaker to CLOSED state.
   * Use with caution - primarily for testing or manual intervention.
   */
  async reset(breakerKey: string): Promise<void> {
    const now = Date.now();
    await this.store.set(breakerKey, {
      ...DEFAULT_METRICS,
      lastStateChange: now,
    });
    console.log('Circuit breaker manually reset to CLOSED state');
  }
}

/**
 * Create a circuit breaker wrapper with pre-configured settings.
 */
export function createCircuitBreaker(config: CircuitBreakerConfig = {}, store?: CircuitBreakerStore): CircuitBreaker {
  return new CircuitBreaker(config, store);
}

/**
 * Registry that maps API slugs to their circuit breaker instances.
 *
 * Used by the gateway health endpoint to retrieve per-slug breaker state
 * without exposing any tenant identifiers.
 */
export class BreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Returns the existing breaker for the given slug, or creates one.
   */
  getOrCreate(slug: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(slug);
    if (!breaker) {
      breaker = new CircuitBreaker(config);
      this.breakers.set(slug, breaker);
    }
    return breaker;
  }

  /**
   * Retrieve the current state of the circuit breaker for a given slug.
   * Returns CLOSED if no breaker exists yet (no failures recorded).
   */
  async getState(slug: string): Promise<CircuitBreakerState> {
    const breaker = this.breakers.get(slug);
    if (!breaker) {
      return CircuitBreakerState.CLOSED;
    }
    return breaker.getState(slug);
  }
}

let _defaultRegistry: BreakerRegistry | undefined;

/**
 * Returns a lazily-created singleton BreakerRegistry.
 * Avoids import-time side effects that break test mocks.
 */
export function getDefaultBreakerRegistry(): BreakerRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new BreakerRegistry();
  }
  return _defaultRegistry;
}
