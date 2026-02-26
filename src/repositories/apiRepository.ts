import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Api, ApiStatus } from '../db/schema.js';

export interface ApiListFilters {
  status?: ApiStatus;
  limit?: number;
  offset?: number;
}

export interface ApiDeveloperInfo {
  name: string | null;
  website: string | null;
  description: string | null;
}

export interface ApiDetails {
  id: number;
  name: string;
  description: string | null;
  base_url: string;
  logo_url: string | null;
  category: string | null;
  status: string;
  developer: ApiDeveloperInfo;
}

export interface ApiEndpointInfo {
  path: string;
  method: string;
  price_per_call_usdc: string;
  description: string | null;
}

export interface ApiRepository {
  findById(id: number): Promise<ApiDetails | null>;
  getEndpoints(apiId: number): Promise<ApiEndpointInfo[]>;
  listByDeveloper(developerId: number, filters?: ApiListFilters): Promise<Api[]>;
}

export const defaultApiRepository: ApiRepository = {
  async findById(): Promise<ApiDetails | null> {
    throw new Error('Not implemented in defaultApiRepository');
  },
  
  async getEndpoints(): Promise<ApiEndpointInfo[]> {
    throw new Error('Not implemented in defaultApiRepository');
  },

  async listByDeveloper(developerId, filters = {}) {
    const conditions = [eq(schema.apis.developer_id, developerId)];
    
    if (filters.status) {
      conditions.push(eq(schema.apis.status, filters.status));
    }

    const baseQuery = db.select().from(schema.apis).where(and(...conditions));

    // Apply limit and offset if provided
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    return baseQuery.limit(limit).offset(offset);
  },
};

// --- In-Memory implementation (for testing) ---

export class InMemoryApiRepository implements ApiRepository {
  private readonly apis: ApiDetails[];
  private readonly endpointsByApiId: Map<number, ApiEndpointInfo[]>;

  constructor(
    apis: ApiDetails[] = [],
    endpointsByApiId: Map<number, ApiEndpointInfo[]> = new Map()
  ) {
    this.apis = [...apis];
    this.endpointsByApiId = new Map(endpointsByApiId);
  }

  async findById(id: number): Promise<ApiDetails | null> {
    return this.apis.find((a) => a.id === id) ?? null;
  }

  async getEndpoints(apiId: number): Promise<ApiEndpointInfo[]> {
    return this.endpointsByApiId.get(apiId) ?? [];
  }

  async listByDeveloper(): Promise<Api[]> {
    throw new Error('Not implemented in InMemoryApiRepository');
  }
}
