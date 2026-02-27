export interface Settlement {
  id: string;
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
