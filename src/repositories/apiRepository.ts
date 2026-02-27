import { eq, and, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Api, ApiEndpoint, NewApi, NewApiEndpoint, ApiStatus, HttpMethod } from '../db/schema.js';

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
    if (filters.status) {
      conditions.push(eq(schema.apis.status, filters.status));
    }

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

// --- Create API (production) ---

export interface CreateEndpointInput {
  path: string;
  method: HttpMethod;
  price_per_call_usdc: string;
  description?: string | null;
}

export interface CreateApiInput {
  developer_id: number;
  name: string;
  description?: string | null;
  base_url: string;
  category?: string | null;
  status?: ApiStatus;
  endpoints: CreateEndpointInput[];
}

export interface ApiWithEndpoints extends Api {
  endpoints: ApiEndpoint[];
}

export async function createApi(input: CreateApiInput): Promise<ApiWithEndpoints> {
  const { endpoints, ...apiData } = input;

  const [api] = await db
    .insert(schema.apis)
    .values({
      developer_id: apiData.developer_id,
      name: apiData.name,
      description: apiData.description ?? null,
      base_url: apiData.base_url,
      category: apiData.category ?? null,
      status: apiData.status ?? 'draft',
    } as NewApi)
    .returning();

  if (!api) throw new Error('API insert failed');

  let endpointRows: ApiEndpoint[] = [];
  if (endpoints.length > 0) {
    endpointRows = await db
      .insert(schema.apiEndpoints)
      .values(
        endpoints.map(
          (e) =>
            ({
              api_id: api.id,
              path: e.path,
              method: e.method,
              price_per_call_usdc: e.price_per_call_usdc,
              description: e.description ?? null,
            }) as NewApiEndpoint,
        ),
      )
      .returning();
  }

  return { ...api, endpoints: endpointRows };
}
