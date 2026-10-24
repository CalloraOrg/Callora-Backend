import type { Awaitable } from './awaitable.js';
import type { Developer } from '../db/schema.js';

/**
 * Alias for the Developer DB type, used throughout the application
 * to represent a developer's profile record.
 */
export type DeveloperProfile = Developer;

export const developerCategoryEnum = [
  'analytics',
  'developer-tools',
  'finance',
  'payments',
  'security',
  'ai',
  'data',
  'productivity',
] as const;

export type DeveloperCategory = (typeof developerCategoryEnum)[number];

export interface Settlement {
  id: string;
  developerId: string; // the dev receiving the payout
  amount: bigint;      // payout in contract units (1 USDC = 10,000,000)
  /** claimed → submitted → retryable (tx_failed_too_early) → completed | failed */
  status: 'claimed' | 'submitted' | 'completed' | 'failed' | 'retryable' | 'pending';
  tx_hash: string | null;
  created_at: string; // ISO-8601
  completed_at?: string | null;
  /** ISO-8601: earliest time the reconciler should re-check this settlement. */
  retry_after?: string | null;
  /** Number of tx_failed_too_early retries already attempted. */
  retry_count?: number;
}

export interface RevenueSummary {
  total_earned: bigint;
  pending: bigint;
  available_to_withdraw: bigint;
}

export interface DeveloperRevenueResponse {
  summary: RevenueSummary;
  settlements: Settlement[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface UpdateDeveloperProfileInput {
  name?: string | null;
  website?: string | null;
  description?: string | null;
  category?: DeveloperCategory | null;
}

export interface SettlementStore {
  create(settlement: Settlement): Awaitable<void>;
  createClaimed?(settlement: Settlement): Awaitable<void>;
  updateStatus(id: string, status: Settlement['status'], txHash?: string | null): Awaitable<void>;
  scheduleRetry(
    id: string,
    retryAfter: string,
    maxRetries?: number,
    lastError?: string,
  ): Awaitable<boolean>;
  getDeveloperSettlements(developerId: string): Awaitable<Settlement[]>;
  getPendingSettlements(): Awaitable<Settlement[]>;
  listPending?(): Awaitable<Settlement[]>;
}
