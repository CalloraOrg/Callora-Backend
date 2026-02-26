export interface HealthResponse {
  status: string;
  service: string;
}

export interface ApisResponse {
  apis: unknown[];
}

export interface UsageResponse {
  calls: number;
  period: string;
}
