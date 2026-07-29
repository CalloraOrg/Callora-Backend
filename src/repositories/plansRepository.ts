import { eq, and, gte, lte, asc, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Plan } from '../db/schema.js';

export interface PlanListFilters {
  priceMin?: string;
  priceMax?: string;
  minRequests?: number;
  sort?: 'price_asc' | 'price_desc' | 'name_asc' | 'name_desc';
}

export interface PlansRepository {
  list(filters?: PlanListFilters): Promise<Plan[]>;
  findById(id: string): Promise<Plan | undefined>;
}

export const defaultPlansRepository: PlansRepository = {
  list,
  findById,
};

export async function list(filters: PlanListFilters = {}): Promise<Plan[]> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters.priceMin !== undefined) {
    conditions.push(gte(schema.plans.priceUsdc, filters.priceMin));
  }
  if (filters.priceMax !== undefined) {
    conditions.push(lte(schema.plans.priceUsdc, filters.priceMax));
  }
  if (filters.minRequests !== undefined) {
    conditions.push(gte(schema.plans.requestsPerMonth, filters.minRequests));
  }

  const query = db
    .select()
    .from(schema.plans)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  if (filters.sort) {
    switch (filters.sort) {
      case 'price_asc':
        query.orderBy(asc(schema.plans.priceUsdc));
        break;
      case 'price_desc':
        query.orderBy(desc(schema.plans.priceUsdc));
        break;
      case 'name_asc':
        query.orderBy(asc(schema.plans.name));
        break;
      case 'name_desc':
        query.orderBy(desc(schema.plans.name));
        break;
    }
  }

  return query;
}

export async function findById(id: string): Promise<Plan | undefined> {
  const rows = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.id, id))
    .limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// In-memory implementation for tests
// ---------------------------------------------------------------------------

export class InMemoryPlansRepository implements PlansRepository {
  private readonly plans: Map<string, Plan>;

  constructor(seed: Plan[] = []) {
    this.plans = new Map(seed.map((p) => [p.id, { ...p }]));
  }

  async list(filters: PlanListFilters = {}): Promise<Plan[]> {
    let results = Array.from(this.plans.values());

    if (filters.priceMin !== undefined) {
      results = results.filter((p) => {
        const price = parseFloat(p.priceUsdc);
        const min = parseFloat(filters.priceMin!);
        return price >= min;
      });
    }
    if (filters.priceMax !== undefined) {
      results = results.filter((p) => {
        const price = parseFloat(p.priceUsdc);
        const max = parseFloat(filters.priceMax!);
        return price <= max;
      });
    }
    if (filters.minRequests !== undefined) {
      results = results.filter((p) => p.requestsPerMonth >= filters.minRequests!);
    }

    if (filters.sort) {
      switch (filters.sort) {
        case 'price_asc':
          results.sort((a, b) => parseFloat(a.priceUsdc) - parseFloat(b.priceUsdc));
          break;
        case 'price_desc':
          results.sort((a, b) => parseFloat(b.priceUsdc) - parseFloat(a.priceUsdc));
          break;
        case 'name_asc':
          results.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'name_desc':
          results.sort((a, b) => b.name.localeCompare(a.name));
          break;
      }
    }

    return results;
  }

  async findById(id: string): Promise<Plan | undefined> {
    return this.plans.get(id);
  }
}
