import type { Awaitable } from './awaitable.js';

export interface Settlement {
  id: string;
  developerId: string; // the dev receiving the payout
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  tx_hash: string | null;
  created_at: string; // ISO-8601
  completed_at?: string | null;
}

export interface RevenueSummary {
  total_earned: number;
  pending: number;
  available_to_withdraw: number;
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

export interface SettlementStore {
  create(settlement: Settlement): Awaitable<void>;
  updateStatus(id: string, status: Settlement['status'], txHash?: string | null): Awaitable<void>;
  getDeveloperSettlements(developerId: string): Awaitable<Settlement[]>;
}
