import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../errors/index.js';
import type { CreateTenantInput, UpdateTenantInput } from '../validators/tenants.js';

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  contactEmail?: string;
  plan: 'starter' | 'growth' | 'enterprise';
  metadata?: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantRepository {
  list(actorId: string): Promise<TenantRecord[]>;
  create(input: CreateTenantInput, actorId: string): Promise<TenantRecord>;
  update(tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord>;
}

export interface TenantRepositoryQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  contact_email: string | null;
  plan: 'starter' | 'growth' | 'enterprise';
  metadata: Record<string, string | number | boolean> | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export function slugifyTenantName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  return slug.length >= 3 ? slug : `tenant-${slug || 'new'}`;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const pgError = error as { code?: string; message?: string };
  if (pgError.code === '23505') {
    return true;
  }
  return typeof pgError.message === 'string' && /unique|duplicate key/i.test(pgError.message);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseMetadata(
  value: TenantRow['metadata'],
): Record<string, string | number | boolean> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, string | number | boolean>;
  }
  return value;
}

function mapTenantRow(row: TenantRow): TenantRecord {
  const record: TenantRecord = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };

  if (row.contact_email !== null && row.contact_email !== undefined) {
    record.contactEmail = row.contact_email;
  }

  const metadata = parseMetadata(row.metadata);
  if (metadata !== undefined) {
    record.metadata = metadata;
  }

  return record;
}

/**
 * In-memory tenant repository used in tests and demo mode when PostgreSQL is
 * not configured.
 *
 * Slug collisions throw {@link ConflictError} (HTTP 409, code `CONFLICT`).
 * Updates against unknown or cross-actor tenant IDs throw {@link NotFoundError}
 * (HTTP 404, code `NOT_FOUND`) to prevent existence probing.
 */
export class InMemoryTenantRepository implements TenantRepository {
  private tenants = new Map<string, TenantRecord>();

  async list(actorId: string): Promise<TenantRecord[]> {
    return Array.from(this.tenants.values()).filter((tenant) => tenant.createdBy === actorId);
  }

  async create(input: CreateTenantInput, actorId: string): Promise<TenantRecord> {
    const now = new Date().toISOString();
    const slug = input.slug ?? slugifyTenantName(input.name);

    for (const existing of this.tenants.values()) {
      if (existing.slug === slug) {
        throw new ConflictError('A tenant with this slug already exists');
      }
    }

    const tenant: TenantRecord = {
      id: `ten_${randomUUID()}`,
      name: input.name,
      slug,
      ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
      plan: input.plan,
      ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async update(tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord> {
    const existing = this.tenants.get(tenantId);
    // Do not create or reveal arbitrary IDs during an update. Both unknown
    // and cross-tenant IDs use the same not-found response to avoid existence
    // probing.
    if (!existing || existing.createdBy !== actorId) {
      throw new NotFoundError('Tenant not found');
    }

    const updated: TenantRecord = {
      ...existing,
      ...input,
      ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.tenants.set(tenantId, updated);
    return updated;
  }
}

/**
 * PostgreSQL-backed tenant repository.
 *
 * - `list(actorId)` returns only tenants created by `actorId`.
 * - `create(input, actorId)` maps unique slug violations (SQLSTATE 23505) to
 *   {@link ConflictError} (HTTP 409, code `CONFLICT`).
 * - `update(tenantId, input, actorId)` scopes the UPDATE to
 *   `WHERE id = $id AND created_by = $actorId` and throws {@link NotFoundError}
 *   (HTTP 404, code `NOT_FOUND`) when no row matches, making unknown and
 *   cross-actor IDs indistinguishable.
 */
export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly db: TenantRepositoryQueryable) {}

  async list(actorId: string): Promise<TenantRecord[]> {
    const { rows } = await this.db.query<TenantRow>(
      `
        SELECT
          id,
          name,
          slug,
          contact_email,
          plan,
          metadata,
          created_by,
          created_at,
          updated_at
        FROM tenants
        WHERE created_by = $1
        ORDER BY created_at ASC, id ASC
      `,
      [actorId],
    );

    return rows.map(mapTenantRow);
  }

  async create(input: CreateTenantInput, actorId: string): Promise<TenantRecord> {
    const id = `ten_${randomUUID()}`;
    const slug = input.slug ?? slugifyTenantName(input.name);
    const now = new Date().toISOString();

    try {
      const { rows } = await this.db.query<TenantRow>(
        `
          INSERT INTO tenants (
            id,
            name,
            slug,
            contact_email,
            plan,
            metadata,
            created_by,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
          RETURNING
            id,
            name,
            slug,
            contact_email,
            plan,
            metadata,
            created_by,
            created_at,
            updated_at
        `,
        [
          id,
          input.name,
          slug,
          input.contactEmail ?? null,
          input.plan,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
          actorId,
          now,
          now,
        ],
      );

      return mapTenantRow(rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A tenant with this slug already exists');
      }
      throw error;
    }
  }

  async update(tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      params.push(input.name);
      sets.push(`name = $${params.length}`);
    }
    if (input.contactEmail !== undefined) {
      params.push(input.contactEmail);
      sets.push(`contact_email = $${params.length}`);
    }
    if (input.plan !== undefined) {
      params.push(input.plan);
      sets.push(`plan = $${params.length}`);
    }
    if (input.metadata !== undefined) {
      params.push(JSON.stringify(input.metadata));
      sets.push(`metadata = $${params.length}::jsonb`);
    }

    const now = new Date().toISOString();
    params.push(now);
    sets.push(`updated_at = $${params.length}`);

    params.push(tenantId);
    const idParam = `$${params.length}`;
    params.push(actorId);
    const actorParam = `$${params.length}`;

    const { rows } = await this.db.query<TenantRow>(
      `
        UPDATE tenants
        SET ${sets.join(', ')}
        WHERE id = ${idParam} AND created_by = ${actorParam}
        RETURNING
          id,
          name,
          slug,
          contact_email,
          plan,
          metadata,
          created_by,
          created_at,
          updated_at
      `,
      params,
    );

    if (rows.length === 0) {
      throw new NotFoundError('Tenant not found');
    }

    return mapTenantRow(rows[0]!);
  }
}
