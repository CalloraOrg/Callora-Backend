import { config } from '../config/index.js';

type QueueEntry = (release: () => void) => void;

/**
 * Per-API-key in-memory semaphore.
 *
 * Each API key gets its own concurrency queue and active slot count.
 * TTL eviction removes state for idle keys automatically, preventing
 * unbounded memory growth for one-off or inactive key IDs.
 *
 * This mirrors {@link DeveloperSemaphore} but keys on API key identity
 * instead of developer identity, enabling per-key concurrency limits
 * and observability via the admin concurrency endpoint.
 */
interface KeyState {
  activeCount: number;
  queue: QueueEntry[];
  evictionTimer?: NodeJS.Timeout;
}

export class KeySemaphore {
  private readonly keys = new Map<string, KeyState>();

  constructor(
    private readonly maxConcurrencyPerKey = 1,
    private readonly ttlMs = 300_000,
  ) {}

  /**
   * Execute `fn` while holding a concurrency slot for the given API key.
   * The slot is automatically released when the returned promise settles.
   */
  async withSlot<T>(keyId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireSlot(keyId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Returns a snapshot of active slot counts per key.
   * Keys with zero active slots are omitted.
   */
  getCurrentActiveSlotCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [keyId, state] of this.keys.entries()) {
      if (state.activeCount > 0) {
        counts[keyId] = state.activeCount;
      }
    }
    return counts;
  }

  /** Returns the total number of active slots across all keys. */
  getTotalActiveSlotCount(): number {
    let total = 0;
    for (const state of this.keys.values()) {
      total += state.activeCount;
    }
    return total;
  }

  /** Returns the active slot count for a specific key, or 0 if not tracked. */
  getActiveSlotCount(keyId: string): number {
    return this.keys.get(keyId)?.activeCount ?? 0;
  }

  /** Returns whether the key has reached its concurrency limit. */
  isAtLimit(keyId: string): boolean {
    const active = this.getActiveSlotCount(keyId);
    return active >= this.maxConcurrencyPerKey;
  }

  /** The configured maximum number of concurrent slots per API key. */
  get maxConcurrency(): number {
    return this.maxConcurrencyPerKey;
  }

  private acquireSlot(keyId: string): Promise<() => void> {
    const state = this.getOrCreateState(keyId);

    // Preserve FIFO fairness: if there are waiting requests, new requests
    // must join the queue behind them, even when capacity is available.
    if (state.queue.length === 0 && state.activeCount < this.maxConcurrencyPerKey) {
      this.clearEvictionTimer(state);
      state.activeCount += 1;
      return Promise.resolve(() => this.releaseSlot(keyId));
    }

    return new Promise<() => void>((resolve) => {
      state.queue.push((release) => {
        this.clearEvictionTimer(state);
        resolve(release);
      });
    });
  }

  private releaseSlot(keyId: string): void {
    const state = this.keys.get(keyId);
    if (!state) {
      return;
    }

    if (state.queue.length > 0) {
      const next = state.queue.shift()!;
      next(() => this.releaseSlot(keyId));
      return;
    }

    state.activeCount -= 1;

    if (state.activeCount === 0) {
      this.scheduleEviction(keyId, state);
    }
  }

  /** Clears all state. Primarily for testing. */
  clear(): void {
    for (const state of this.keys.values()) {
      this.clearEvictionTimer(state);
    }
    this.keys.clear();
  }

  private getOrCreateState(keyId: string): KeyState {
    let state = this.keys.get(keyId);
    if (!state) {
      state = { activeCount: 0, queue: [] };
      this.keys.set(keyId, state);
    }
    return state;
  }

  private scheduleEviction(keyId: string, state: KeyState): void {
    this.clearEvictionTimer(state);
    state.evictionTimer = setTimeout(() => {
      const current = this.keys.get(keyId);
      if (current && current.activeCount === 0 && current.queue.length === 0) {
        this.keys.delete(keyId);
      }
    }, this.ttlMs);
    state.evictionTimer.unref?.();
  }

  private clearEvictionTimer(state: KeyState): void {
    if (state.evictionTimer) {
      clearTimeout(state.evictionTimer);
      state.evictionTimer = undefined;
    }
  }
}

/**
 * Shared singleton KeySemaphore instance used across the gateway middleware
 * and the admin concurrency stats route. Tests should create isolated
 * instances via the class constructor directly.
 *
 * Both sides must use this same instance: the gateway proxy acquires slots on
 * it (see `createPerKeyConcurrencyMiddleware`) and the admin stats route reads
 * from it. A separate instance on either side would report counts of zero.
 */
export const sharedKeySemaphore = new KeySemaphore(
  config.keyConcurrency.maxPerKey,
  config.keyConcurrency.semaphoreTtlMs,
);
