export interface DbHealthStatus {
  status: 'ok' | 'error';
  error?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  db?: DbHealthStatus;
}

export interface ApisResponse {
  apis: unknown[];
}

export interface UsageResponse {
  calls: number;
  period: string;
}
