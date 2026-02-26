import { eq } from 'drizzle-orm';
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
  listByDeveloper?(developerId: number, filters?: ApiListFilters): Promise<Api[]>;
  findById?(id: number): Promise<ApiDetails | null>;
  getEndpoints?(apiId: number): Promise<ApiEndpointInfo[]>;
}

export const defaultApiRepository: ApiRepository = {
  async listByDeveloper(developerId, filters = {}) {
    let results = await db
      .select()
      .from(schema.apis)
      .where(eq(schema.apis.developer_id, developerId));

    if (filters.status) {
      results = results.filter((api) => api.status === filters.status);
    }

    if (typeof filters.offset === 'number') {
      results = results.slice(filters.offset);
    }

    if (typeof filters.limit === 'number') {
      results = results.slice(0, filters.limit);
    }

    return results;
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
}
