import { eq, and, like, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Api, NewApi } from '../db/schema.js';
import type {
  ApiCreateInput,
  ApiDetails,
  ApiEndpointInfo,
  ApiListFilters,
  ApiRepository,
  ApiUpdateInput,
} from './apiRepository.js';

export class DrizzleApiRepository implements ApiRepository {
  async create(api: ApiCreateInput): Promise<Api> {
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
  }

  async update(id: number, data: ApiUpdateInput): Promise<Api | null> {
    const payload: Partial<NewApi> = {};
    if (typeof data.name === 'string') payload.name = data.name;
    if (typeof data.description === 'string' || data.description === null) payload.description = data.description;
    if (typeof data.base_url === 'string') payload.base_url = data.base_url;
    if (typeof data.logo_url === 'string' || data.logo_url === null) payload.logo_url = data.logo_url;
    if (typeof data.category === 'string' || data.category === null) payload.category = data.category;
    if (data.status) payload.status = data.status;

    if (Object.keys(payload).length === 0) {
      const rows = await db.select().from(schema.apis).where(eq(schema.apis.id, id)).limit(1);
      return rows[0] ?? null;
    }

    payload.updated_at = new Date();

    const [updated] = await db
      .update(schema.apis)
      .set(payload)
      .where(eq(schema.apis.id, id))
      .returning();

    return updated ?? null;
  }

  async listByDeveloper(developerId: number, filters: ApiListFilters = {}): Promise<Api[]> {
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
  }

  async listPublic(filters: ApiListFilters = {}): Promise<Api[]> {
    if (filters.status && filters.status !== 'active') {
      return [];
    }

    const conditions: SQL[] = [eq(schema.apis.status, 'active')];
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
  }

  async findById(id: number): Promise<ApiDetails | null> {
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
  }

  async getEndpoints(apiId: number): Promise<ApiEndpointInfo[]> {
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
  }
}
