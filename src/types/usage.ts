export interface UsageEvent {
  id: string;
  userId: string;
  walletAddress: string;
  apiEndpoint: string;
  method: string;
  timestamp: Date;
  cost: number;
  statusCode: number;
  responseTime: number;
}

export interface UsageStats {
  totalSpent: number;
  totalCalls: number;
  period: {
    from: Date;
    to: Date;
  };
  breakdown?: {
    [apiEndpoint: string]: {
      calls: number;
      cost: number;
      avgResponseTime: number;
    };
  };
}

export interface UsageQueryParams {
  from?: string;
  to?: string;
  limit?: string;
}
