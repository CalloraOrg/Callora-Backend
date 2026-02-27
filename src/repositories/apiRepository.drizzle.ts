import { eq, and, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Api } from '../db/schema.js';
import type { ApiDetails, ApiEndpointInfo, ApiListFilters, ApiRepository } from './apiRepository.js';

export class DrizzleApiRepository implements ApiRepository {
  async listByDeveloper(developerId: number, filters: ApiListFilters = {}): Promise<Api[]> {
    const conditions: SQL[] = [eq(schema.apis.developer_id, developerId)];
    if (filters.status) {
      conditions.push(eq(schema.apis.status, filters.status));
    }
    const results = await db.select().from(schema.apis).where(and(...conditions));
    let rows = results as Api[];
    if (typeof filters.offset === 'number') {
      rows = rows.slice(filters.offset);
    }
    if (typeof filters.limit === 'number') {
      rows = rows.slice(0, filters.limit);
    }
    return rows;
    const conditions = [eq(schema.apis.developer_id, developerId)];
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
