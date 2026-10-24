import { DeveloperSemaphore } from '../utils/developerSemaphore.js';
import { KeySemaphore } from '../utils/keySemaphore.js';
import client from 'prom-client';
import { register } from '../metrics.js';

export type LimiterInstance = DeveloperSemaphore | KeySemaphore;

export interface LimiterInfo {
  name: string;
  limiter: LimiterInstance;
  type: 'developer' | 'key';
}

const concurrencyActiveSlots = new client.Gauge({
  name: 'concurrency_active_slots',
  help: 'Total active concurrency slots held per limiter',
  labelNames: ['limiter'],
});

const concurrencyQueued = new client.Gauge({
  name: 'concurrency_queued',
  help: 'Total waiting/queued concurrency requests per limiter',
  labelNames: ['limiter'],
});

register.registerMetric(concurrencyActiveSlots);
register.registerMetric(concurrencyQueued);

export { concurrencyActiveSlots, concurrencyQueued };

export class ConcurrencyRegistry {
  private readonly limiters = new Map<string, LimiterInfo>();

  register(name: string, limiter: LimiterInstance, type: 'developer' | 'key' = 'developer'): void {
    limiter.setOnStateChange(() => {
      this.updateMetrics(name);
    });
    this.limiters.set(name, { name, limiter, type });
    this.updateMetrics(name);
  }

  unregister(name: string): void {
    const info = this.limiters.get(name);
    if (info) {
      info.limiter.setOnStateChange(undefined);
      this.limiters.delete(name);
      concurrencyActiveSlots.remove({ limiter: name });
      concurrencyQueued.remove({ limiter: name });
    }
  }

  get(name: string): LimiterInfo | undefined {
    return this.limiters.get(name);
  }

  has(name: string): boolean {
    return this.limiters.has(name);
  }

  getAll(): LimiterInfo[] {
    return Array.from(this.limiters.values());
  }

  clear(): void {
    for (const [name, info] of this.limiters.entries()) {
      info.limiter.setOnStateChange(undefined);
      concurrencyActiveSlots.remove({ limiter: name });
      concurrencyQueued.remove({ limiter: name });
    }
    this.limiters.clear();
  }

  updateMetrics(name?: string): void {
    if (name) {
      const info = this.limiters.get(name);
      if (info) {
        const active = info.limiter.getTotalActiveSlotCount();
        const queued = info.limiter.getTotalQueuedCount();
        concurrencyActiveSlots.set({ limiter: name }, active);
        concurrencyQueued.set({ limiter: name }, queued);
      }
      return;
    }

    for (const [limiterName, info] of this.limiters.entries()) {
      const active = info.limiter.getTotalActiveSlotCount();
      const queued = info.limiter.getTotalQueuedCount();
      concurrencyActiveSlots.set({ limiter: limiterName }, active);
      concurrencyQueued.set({ limiter: limiterName }, queued);
    }
  }
}

export const concurrencyRegistry = new ConcurrencyRegistry();
