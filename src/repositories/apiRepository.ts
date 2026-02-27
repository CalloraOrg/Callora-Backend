import { eq, and, type SQL } from 'drizzle-orm';
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
  listByDeveloper(developerId: number, filters?: ApiListFilters): Promise<Api[]>;
  findById(id: number): Promise<ApiDetails | null>;
  getEndpoints(apiId: number): Promise<ApiEndpointInfo[]>;
}

export const defaultApiRepository: ApiRepository = {
  async listByDeveloper(developerId, filters = {}) {
    const conditions: SQL[] = [eq(schema.apis.developer_id, developerId)];
    const conditions = [eq(schema.apis.developer_id, developerId)];
    if (filters.status) {
      conditions.push(eq(schema.apis.status, filters.status));
    }

    const results = await db
      .select()
      .from(schema.apis)
      .where(and(...conditions));

    let rows = results as Api[];
    if (typeof filters.offset === 'number') {
      rows = rows.slice(filters.offset);
    }
    if (typeof filters.limit === 'number') {
      rows = rows.slice(0, filters.limit);
    }
    return rows;
    let query = db.select().from(schema.apis).where(and(...conditions));

    if (typeof filters.limit === 'number') {
      query = query.limit(filters.limit) as typeof query;
    }

    if (typeof filters.offset === 'number') {
      query = query.offset(filters.offset) as typeof query;
    }

    return query;
  },

  async findById() {
    return null;
  },

  async getEndpoints() {
    return [];
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

  async listByDeveloper(): Promise<Api[]> {
    return [];
  }

  async findById(id: number): Promise<ApiDetails | null> {
    return this.apis.find((a) => a.id === id) ?? null;
  }

  async getEndpoints(apiId: number): Promise<ApiEndpointInfo[]> {
    return this.endpointsByApiId.get(apiId) ?? [];
  }
}
