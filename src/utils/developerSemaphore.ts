interface QueueEntry {
  resolve: (release: () => void) => void;
}

/**
 * Per-developer in-memory semaphore.
 *
 * Each developer gets its own concurrency queue and active slot count.
 * TTL eviction removes state for idle developers automatically, preventing
 * unbounded memory growth for one-off or inactive developer IDs.
 */
interface DeveloperState {
  activeCount: number;
  queue: QueueEntry[];
  evictionTimer?: NodeJS.Timeout;
}

export class DeveloperSemaphore {
  private readonly developers = new Map<string, DeveloperState>();

  constructor(
    private readonly maxConcurrencyPerDeveloper = 1,
    private readonly ttlMs = 300_000,
  ) {}

  async withSlot<T>(developerId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireSlot(developerId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  getCurrentActiveSlotCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [developerId, state] of this.developers.entries()) {
      if (state.activeCount > 0) {
        counts[developerId] = state.activeCount;
      }
    }
    return counts;
  }

  getTotalActiveSlotCount(): number {
    let total = 0;
    for (const state of this.developers.values()) {
      total += state.activeCount;
    }
    return total;
  }

  private acquireSlot(developerId: string): Promise<() => void> {
    const state = this.getOrCreateState(developerId);

    // Preserve FIFO fairness: if there are waiting requests, new requests
    // must join the queue behind them, even when capacity is available.
    if (state.queue.length === 0 && state.activeCount < this.maxConcurrencyPerDeveloper) {
      this.clearEvictionTimer(state);
      state.activeCount += 1;
      return Promise.resolve(() => this.releaseSlot(developerId));
    }

    return new Promise<() => void>((resolve) => {
      state.queue.push((release) => {
        this.clearEvictionTimer(state);
        resolve(release);
      });
    });
  }

  private releaseSlot(developerId: string): void {
    const state = this.developers.get(developerId);
    if (!state) {
      return;
    }

    if (state.queue.length > 0) {
      const next = state.queue.shift()!;
      next(() => this.releaseSlot(developerId));
      return;
    }

    state.activeCount -= 1;

    if (state.activeCount === 0) {
      this.scheduleEviction(developerId, state);
    }
  }

  clear(): void {
    for (const state of this.developers.values()) {
      this.clearEvictionTimer(state);
    }
    this.developers.clear();
  }

  private getOrCreateState(developerId: string): DeveloperState {
    let state = this.developers.get(developerId);
    if (!state) {
      state = { activeCount: 0, queue: [] };
      this.developers.set(developerId, state);
    }
    return state;
  }

  private scheduleEviction(developerId: string, state: DeveloperState): void {
    this.clearEvictionTimer(state);
    state.evictionTimer = setTimeout(() => {
      const current = this.developers.get(developerId);
      if (current && current.activeCount === 0 && current.queue.length === 0) {
        this.developers.delete(developerId);
      }
    }, this.ttlMs);
    state.evictionTimer.unref?.();
  }

  private clearEvictionTimer(state: DeveloperState): void {
    if (state.evictionTimer) {
      clearTimeout(state.evictionTimer);
      state.evictionTimer = undefined;
    }
  }
}
