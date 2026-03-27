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
  developer: {
    name: string | null;
    website: string | null;
    description: string | null;
  };
}

export interface ApisResponse {
  apis: ApiSummary[];
}

export interface UsageResponse {
  calls: number;
  period: string;
}
