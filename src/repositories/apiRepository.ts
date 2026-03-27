import { eq, and, like, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Api, ApiEndpoint, NewApi, NewApiEndpoint, ApiStatus, HttpMethod } from '../db/schema.js';

export interface ApiListFilters {
  status?: ApiStatus;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ApiCreateInput {
  developer_id: number;
  name: string;
  description?: string | null;
  base_url: string;
  logo_url?: string | null;
  category?: string | null;
  status?: ApiStatus;
}

export interface ApiUpdateInput {
  name?: string;
  description?: string | null;
  base_url?: string;
  logo_url?: string | null;
  category?: string | null;
  status?: ApiStatus;
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
  create(api: ApiCreateInput): Promise<Api>;
  update(id: number, data: ApiUpdateInput): Promise<Api | null>;
  listByDeveloper(developerId: number, filters?: ApiListFilters): Promise<Api[]>;
  listPublic(filters?: ApiListFilters): Promise<Api[]>;
  findById(id: number): Promise<ApiDetails | null>;
  getEndpoints(apiId: number): Promise<ApiEndpointInfo[]>;
}

export const defaultApiRepository: ApiRepository = {
  async create(api) {
    const [created] = await db
      .insert(schema.apis)
      .values({
        developer_id: api.developer_id,
        name: api.name,
        description: api.description ?? null,
        base_url: api.base_url,
        logo_url: api.logo_url ?? null,
        category: api.category ?? null,
        status: api.status ?? 'draft',
      } as NewApi)
      .returning();

    if (!created) throw new Error('API insert failed');
    return created;
  },

  async update(id, data) {
    const payload: Partial<NewApi> = {};
    if (typeof data.name === 'string') payload.name = data.name;
    if (typeof data.description === 'string' || data.description === null) payload.description = data.description;
    if (typeof data.base_url === 'string') payload.base_url = data.base_url;
    if (typeof data.logo_url === 'string' || data.logo_url === null) payload.logo_url = data.logo_url;
    if (typeof data.category === 'string' || data.category === null) payload.category = data.category;
    if (data.status) payload.status = data.status;

    if (Object.keys(payload).length === 0) {
      const existing = await db.select().from(schema.apis).where(eq(schema.apis.id, id)).limit(1);
      return existing[0] ?? null;
    }

    payload.updated_at = new Date();

    const [updated] = await db
      .update(schema.apis)
      .set(payload)
      .where(eq(schema.apis.id, id))
      .returning();

    return updated ?? null;
  },

  async listByDeveloper(developerId, filters = {}) {
    const conditions: SQL[] = [eq(schema.apis.developer_id, developerId)];
    if (filters.status) {
      conditions.push(eq(schema.apis.status, filters.status));
    }
    if (filters.category) {
      conditions.push(eq(schema.apis.category, filters.category));
    }
    if (filters.search) {
      conditions.push(like(schema.apis.name, `%${filters.search}%`));
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

  async listPublic(filters = {}) {
    const conditions: SQL[] = [eq(schema.apis.status, 'active')];
    if (filters.category) {
      conditions.push(eq(schema.apis.category, filters.category));
    }
    if (filters.search) {
      conditions.push(like(schema.apis.name, `%${filters.search}%`));
    }

    if (filters.status && filters.status !== 'active') {
      return [];
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

  async findById(id) {
    const rows = await db
      .select({
        id: schema.apis.id,
        name: schema.apis.name,
        description: schema.apis.description,
        base_url: schema.apis.base_url,
        logo_url: schema.apis.logo_url,
        category: schema.apis.category,
        status: schema.apis.status,
        developer_name: schema.developers.name,
        developer_website: schema.developers.website,
        developer_description: schema.developers.description,
      })
      .from(schema.apis)
      .leftJoin(schema.developers, eq(schema.apis.developer_id, schema.developers.id))
      .where(and(eq(schema.apis.id, id), eq(schema.apis.status, 'active')))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      base_url: row.base_url,
      logo_url: row.logo_url,
      category: row.category,
      status: row.status,
      developer: {
        name: row.developer_name ?? null,
        website: row.developer_website ?? null,
        description: row.developer_description ?? null,
      },
    };
  },

  async getEndpoints(apiId) {
    const rows = await db
      .select({
        path: schema.apiEndpoints.path,
        method: schema.apiEndpoints.method,
        price_per_call_usdc: schema.apiEndpoints.price_per_call_usdc,
        description: schema.apiEndpoints.description,
      })
      .from(schema.apiEndpoints)
      .where(eq(schema.apiEndpoints.api_id, apiId));

    return rows.map((r) => ({
      path: r.path,
      method: r.method,
      price_per_call_usdc: r.price_per_call_usdc,
      description: r.description,
    }));
  },
};

// --- In-Memory implementation (for testing) ---

export class InMemoryApiRepository implements ApiRepository {
  private readonly apis: Api[];
  private readonly detailsById: Map<number, ApiDetails>;
  private readonly endpointsByApiId: Map<number, ApiEndpointInfo[]>;
  private nextId: number;

  constructor(
    apis: Array<ApiDetails | Api> = [],
    endpointsByApiId: Map<number, ApiEndpointInfo[]> = new Map()
  ) {
    this.apis = apis.map((api) => this.toApi(api));
    this.detailsById = new Map(
      apis.map((api) => {
        if ('developer' in api) return [api.id, api];
        return [
          api.id,
          {
            id: api.id,
            name: api.name,
            description: api.description,
            base_url: api.base_url,
            logo_url: api.logo_url,
            category: api.category,
            status: api.status,
            developer: { name: null, website: null, description: null },
          } as ApiDetails,
        ];
      })
    );
    this.endpointsByApiId = new Map(endpointsByApiId);
    this.nextId = Math.max(0, ...this.apis.map((a) => a.id)) + 1;
  }

  private toApi(api: ApiDetails | Api): Api {
    if (!('developer' in api)) return api;
    return {
      id: api.id,
      developer_id: 0,
      name: api.name,
      description: api.description,
      base_url: api.base_url,
      logo_url: api.logo_url,
      category: api.category,
      status: api.status as ApiStatus,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
  }

  async create(api: ApiCreateInput): Promise<Api> {
    const now = new Date();
    const created: Api = {
      id: this.nextId++,
      developer_id: api.developer_id,
      name: api.name,
      description: api.description ?? null,
      base_url: api.base_url,
      logo_url: api.logo_url ?? null,
      category: api.category ?? null,
      status: api.status ?? 'draft',
      created_at: now,
      updated_at: now,
    };
    this.apis.push(created);
    this.detailsById.set(created.id, {
      id: created.id,
      name: created.name,
      description: created.description,
      base_url: created.base_url,
      logo_url: created.logo_url,
      category: created.category,
      status: created.status,
      developer: { name: null, website: null, description: null },
    });
    return created;
  }

  async update(id: number, data: ApiUpdateInput): Promise<Api | null> {
    const index = this.apis.findIndex((a) => a.id === id);
    if (index === -1) return null;
    const current = this.apis[index];
    const updated: Api = {
      ...current,
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      ...(typeof data.description === 'string' || data.description === null
        ? { description: data.description }
        : {}),
      ...(typeof data.base_url === 'string' ? { base_url: data.base_url } : {}),
      ...(typeof data.logo_url === 'string' || data.logo_url === null ? { logo_url: data.logo_url } : {}),
      ...(typeof data.category === 'string' || data.category === null ? { category: data.category } : {}),
      ...(data.status ? { status: data.status } : {}),
      updated_at: new Date(),
    };
    this.apis[index] = updated;

    const details = this.detailsById.get(id);
    if (details) {
      this.detailsById.set(id, {
        ...details,
        name: updated.name,
        description: updated.description,
        base_url: updated.base_url,
        logo_url: updated.logo_url,
        category: updated.category,
        status: updated.status,
      });
    }
    return updated;
  }

  async listByDeveloper(developerId: number, filters: ApiListFilters = {}): Promise<Api[]> {
    let results = this.apis.filter((api) => api.developer_id === developerId);
    if (filters.status) {
      results = results.filter((api) => api.status === filters.status);
    }
    if (filters.category) {
      results = results.filter((api) => api.category === filters.category);
    }
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      results = results.filter((api) => api.name.toLowerCase().includes(needle));
    }
    if (typeof filters.offset === 'number') {
      results = results.slice(filters.offset);
    }
    if (typeof filters.limit === 'number') {
      results = results.slice(0, filters.limit);
    }
    return results;
  }

  async listPublic(filters: ApiListFilters = {}): Promise<Api[]> {
    if (filters.status && filters.status !== 'active') return [];
    let results = this.apis.filter((api) => api.status === 'active');
    if (filters.category) {
      results = results.filter((api) => api.category === filters.category);
    }
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      results = results.filter((api) => api.name.toLowerCase().includes(needle));
    }
    if (typeof filters.offset === 'number') {
      results = results.slice(filters.offset);
    }
    if (typeof filters.limit === 'number') {
      results = results.slice(0, filters.limit);
    }
    return results;
  }

  async findById(id: number): Promise<ApiDetails | null> {
    const item = this.detailsById.get(id) ?? null;
    if (!item || item.status !== 'active') return null;
    return item;
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
