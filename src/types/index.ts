export type HealthComponentStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: HealthComponentStatus;
  service?: string;
  version?: string;
  timestamp?: string;
  checks?: {
    api: HealthComponentStatus;
    database: HealthComponentStatus;
    soroban_rpc?: HealthComponentStatus;
    horizon?: HealthComponentStatus;
  };
  db?: {
    status: 'ok' | 'error';
    error?: string;
  };
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
