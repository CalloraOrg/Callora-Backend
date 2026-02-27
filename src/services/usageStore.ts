import { UsageStore, UsageEvent } from '../types/gateway.js';

/**
 * In-memory usage event store with idempotency.
 * In production this would write to a database table.
 */
export class InMemoryUsageStore implements UsageStore {
  private events: UsageEvent[] = [];
  private requestIds = new Set<string>();

  /**
   * Record a usage event.
   * Returns false if an event with the same requestId already exists (idempotent).
   */
  record(event: UsageEvent): boolean {
    if (this.requestIds.has(event.requestId)) {
      return false; // duplicate — skip
    }
    this.requestIds.add(event.requestId);
    this.events.push(event);
    return true;
  }

  /** Check if an event with this requestId has been recorded. */
  hasEvent(requestId: string): boolean {
    return this.requestIds.has(requestId);
  }

  getEvents(apiKey?: string): UsageEvent[] {
    if (apiKey) {
      return this.events.filter((e) => e.apiKey === apiKey);
    }
    return [...this.events];
  }

  /** Helper for tests — clear all events. */
  clear(): void {
    this.events = [];
    this.requestIds.clear();
  }
}

export function createUsageStore(): InMemoryUsageStore {
  return new InMemoryUsageStore();
}
