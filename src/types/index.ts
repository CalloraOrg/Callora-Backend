export interface DbHealthStatus {
  status: 'ok' | 'error';
  error?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  db?: DbHealthStatus;
}

export interface ApiSummary {
  id: number;
  name: string;
  description: string | null;
  base_url: string;
  logo_url: string | null;
  category: string | null;
  status: string;
  endpoints?: Array<{
    path: string;
    method: string;
    price_per_call_usdc: string;
    description: string | null;
  }>;
  developer: {
    name: string | null;
    website: string | null;
    description: string | null;
  };
}

export interface ApisResponse {
  apis: ApiSummary[];
}

export interface PaginatedApisResponse {
  data: ApiSummary[];
  meta: {
    total?: number;
    limit: number;
    offset: number;
  };
}

export interface UsageResponse {
  calls: number;
  period: string;
}
