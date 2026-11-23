/**
 * src/services/postgresPluginRepository.ts
 *
 * PostgreSQL-backed implementation of PluginRepository for the community
 * plugin marketplace.
 */

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/index.js';
import type {
  PluginManifest,
  PluginRecord,
  PluginRepository,
  PluginStatus,
} from './pluginRegistry.js';

export interface PluginRepositoryQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface MarketplacePluginRow {
  id: string;
  manifest: PluginManifest | string;
  owner_id: string;
  status: PluginStatus;
  installed_by: string | null;
  installed_at: Date | string | null;
  created_at: Date | string;
}

const SELECT_COLUMNS =
  'id, manifest, owner_id, status, installed_by, installed_at, created_at';

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: MarketplacePluginRow): PluginRecord {
  const manifest: PluginManifest =
    typeof row.manifest === 'string'
      ? (JSON.parse(row.manifest) as PluginManifest)
      : row.manifest;

  return {
    manifest,
    owner_id: row.owner_id,
    status: row.status,
    installed_by: row.installed_by ?? null,
    installed_at: row.installed_at != null ? toIsoString(row.installed_at) : null,
    created_at: toIsoString(row.created_at),
  };
}

export class PostgresPluginRepository implements PluginRepository {
  constructor(private readonly db: PluginRepositoryQueryable) {}

  async list(): Promise<PluginRecord[]> {
    const { rows } = await this.db.query<MarketplacePluginRow>(
      `SELECT ${SELECT_COLUMNS} FROM marketplace_plugins ORDER BY created_at ASC`,
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<PluginRecord | undefined> {
    const { rows } = await this.db.query<MarketplacePluginRow>(
      `SELECT ${SELECT_COLUMNS} FROM marketplace_plugins WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async register(manifest: PluginManifest, ownerId: string): Promise<PluginRecord> {
    const { rows } = await this.db.query<MarketplacePluginRow>(
      `INSERT INTO marketplace_plugins (id, manifest, owner_id, status, installed_by, installed_at, created_at)
       VALUES ($1, $2::jsonb, $3, 'available', NULL, NULL, NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [manifest.id, JSON.stringify(manifest), ownerId],
    );

    if (rows.length === 0) {
      throw new ConflictError(`Plugin '${manifest.id}' is already registered`, 'CONFLICT');
    }

    return mapRow(rows[0]!);
  }

  async install(id: string, userId: string): Promise<PluginRecord> {
    const { rows } = await this.db.query<MarketplacePluginRow>(
      `UPDATE marketplace_plugins
       SET status = 'installed', installed_by = $2, installed_at = NOW()
       WHERE id = $1 AND status = 'available'
       RETURNING ${SELECT_COLUMNS}`,
      [id, userId],
    );

    if (rows.length > 0) {
      return mapRow(rows[0]!);
    }

    const existing = await this.db.query<{ status: PluginStatus }>(
      `SELECT status FROM marketplace_plugins WHERE id = $1`,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new NotFoundError(`Plugin '${id}' not found`);
    }

    throw new ConflictError(`Plugin '${id}' is already installed`, 'CONFLICT');
  }

  async uninstall(id: string, userId: string): Promise<PluginRecord> {
    const { rows } = await this.db.query<MarketplacePluginRow>(
      `UPDATE marketplace_plugins
       SET status = 'available', installed_by = $2, installed_at = NULL
       WHERE id = $1 AND status = 'installed'
       RETURNING ${SELECT_COLUMNS}`,
      [id, userId],
    );

    if (rows.length > 0) {
      return mapRow(rows[0]!);
    }

    const existing = await this.db.query<{ status: PluginStatus }>(
      `SELECT status FROM marketplace_plugins WHERE id = $1`,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new NotFoundError(`Plugin '${id}' not found`);
    }

    throw new BadRequestError(`Plugin '${id}' is not installed`, 'BAD_REQUEST');
  }

  async delete(id: string, requesterId: string, isAdmin = false): Promise<void> {
    if (isAdmin) {
      const { rows } = await this.db.query<{ id: string }>(
        `DELETE FROM marketplace_plugins WHERE id = $1 RETURNING id`,
        [id],
      );
      if (rows.length === 0) {
        throw new NotFoundError(`Plugin '${id}' not found`);
      }
      return;
    }

    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM marketplace_plugins WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [id, requesterId],
    );

    if (rows.length > 0) {
      return;
    }

    const existing = await this.db.query<{ owner_id: string }>(
      `SELECT owner_id FROM marketplace_plugins WHERE id = $1`,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new NotFoundError(`Plugin '${id}' not found`);
    }

    throw new ForbiddenError(`You do not have permission to delete plugin '${id}'`);
  }
}
