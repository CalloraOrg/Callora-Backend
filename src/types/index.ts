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

export type {
  CalloraEventListener,
  CalloraEventName,
  CalloraEventPayloadMap,
  CalloraEventUnsubscribe,
} from '../events/event.emitter.js';
