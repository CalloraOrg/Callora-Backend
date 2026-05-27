export const developerCategoryEnum = [
  'ai',
  'analytics',
  'data',
  'developer-tools',
  'finance',
  'productivity',
  'search',
  'security',
  'weather',
] as const;

export type DeveloperCategory = typeof developerCategoryEnum[number];

export interface DeveloperProfile {
  id: number;
  user_id: string;
  name: string | null;
  website: string | null;
  description: string | null;
  category: DeveloperCategory | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpdateDeveloperProfileInput {
  name?: string | null;
  website?: string | null;
  description?: string | null;
  category?: DeveloperCategory | null;
}

export interface Settlement {
  id: string;
  developerId: string; // the dev receiving the payout
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  tx_hash: string | null;
  created_at: string; // ISO-8601
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
  create(settlement: Settlement): void;
  updateStatus(id: string, status: Settlement['status'], txHash?: string | null): void;
  getDeveloperSettlements(developerId: string): Settlement[];
}
