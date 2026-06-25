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

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  cooldownMs: 30000,
  successThreshold: 1,
};

/**
 * Circuit Breaker implementation with automatic state management.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange: number = Date.now();
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute an operation through the circuit breaker.
   * 
   * @param operation - Async function to execute
   * @returns Result of the operation
   * @throws CircuitBreakerOpenError if circuit is open
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitBreakerState.OPEN) {
      const timeSinceFailure = Date.now() - (this.lastFailureTime ?? 0);
      if (timeSinceFailure >= this.config.cooldownMs) {
        this.transitionTo(CircuitBreakerState.HALF_OPEN);
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
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful operation execution.
   */
  private onSuccess(): void {
    this.totalSuccesses++;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo(CircuitBreakerState.CLOSED);
        this.consecutiveSuccesses = 0;
      }
    }
  }

  /**
   * Handle failed operation execution.
   */
  private onFailure(): void {
    this.totalFailures++;
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Immediate transition back to OPEN on any failure in HALF_OPEN
      this.transitionTo(CircuitBreakerState.OPEN);
    } else if (this.state === CircuitBreakerState.CLOSED) {
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this.transitionTo(CircuitBreakerState.OPEN);
      }
    }
  }

  /**
   * Transition to a new circuit breaker state.
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    console.log(
      `Circuit breaker state transition: ${oldState} → ${newState} ` +
      `(failures: ${this.consecutiveFailures}, successes: ${this.consecutiveSuccesses})`
    );

    // Reset consecutive counters on state change
    if (newState === CircuitBreakerState.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Get current circuit breaker metrics.
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
    };
  }

  /**
   * Get current state.
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Force reset the circuit breaker to CLOSED state.
   * Use with caution - primarily for testing or manual intervention.
   */
  reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastStateChange = Date.now();
    console.log('Circuit breaker manually reset to CLOSED state');
  }
}

/**
 * Create a circuit breaker wrapper with pre-configured settings.
 */
export function createCircuitBreaker(config: CircuitBreakerConfig = {}): CircuitBreaker {
  return new CircuitBreaker(config);
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
  getState(slug: string): CircuitBreakerState {
    const breaker = this.breakers.get(slug);
    if (!breaker) {
      return CircuitBreakerState.CLOSED;
    }
    return breaker.getState();
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
