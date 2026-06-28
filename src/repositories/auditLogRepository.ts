import type { CursorPayload } from '../lib/cursorPagination.js';
import { readQuery } from '../db.js';

export interface AuditLogEntry {
  id: string;
  event: string;
  actor: string;
  tenantId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  correlationId: string | null;
  bodyHash: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogCursorFilters {
  event?: string;
  tenantId?: string;
  actor?: string;
  from?: Date;
  to?: Date;
}

export interface FindAuditLogsCursorParams extends AuditLogCursorFilters {
  limit: number;
  afterCursor?: CursorPayload;
}

export interface FindAuditLogsCursorResult {
  entries: AuditLogEntry[];
  hasMore: boolean;
}

export interface AuditLogRepository {
  findCursor(params: FindAuditLogsCursorParams): Promise<FindAuditLogsCursorResult>;
}

export interface AuditLogRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface AuditLogRow {
  id: string;
  event: string;
  actor: string;
  tenant_id: string | null;
  client_ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  body_hash: string | null;
  details: string | null;
  created_at: Date | string;
}

const parseDetails = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const mapAuditLogRow = (row: AuditLogRow): AuditLogEntry => ({
  id: row.id,
  event: row.event,
  actor: row.actor,
  tenantId: row.tenant_id,
  clientIp: row.client_ip,
  userAgent: row.user_agent,
  correlationId: row.correlation_id,
  bodyHash: row.body_hash,
  details: parseDetails(row.details),
  createdAt: row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString(),
});

export class PgAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db?: AuditLogRepositoryQueryable) {}

  async findCursor(params: FindAuditLogsCursorParams): Promise<FindAuditLogsCursorResult> {
    const fetchLimit = Math.max(1, params.limit) + 1;
    const sqlParams: unknown[] = [];
    const whereClauses: string[] = [];

    if (params.event) {
      sqlParams.push(params.event);
      whereClauses.push(`event = $${sqlParams.length}`);
    }

    if (params.tenantId) {
      sqlParams.push(params.tenantId);
      whereClauses.push(`tenant_id = $${sqlParams.length}`);
    }

    if (params.actor) {
      sqlParams.push(params.actor);
      whereClauses.push(`actor = $${sqlParams.length}`);
    }

    if (params.from) {
      sqlParams.push(params.from);
      whereClauses.push(`created_at >= $${sqlParams.length}`);
    }

    if (params.to) {
      sqlParams.push(params.to);
      whereClauses.push(`created_at <= $${sqlParams.length}`);
    }

    if (params.afterCursor) {
      // Keyset pagination over (created_at DESC, id DESC):
      // fetch rows strictly older than the cursor position.
      sqlParams.push(params.afterCursor.timestamp);
      sqlParams.push(params.afterCursor.id);
      const tsIdx = sqlParams.length - 1;
      const idIdx = sqlParams.length;
      whereClauses.push(
        `(created_at < $${tsIdx} OR (created_at = $${tsIdx} AND id < $${idIdx}))`,
      );
    }

    sqlParams.push(fetchLimit);

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await this.read<AuditLogRow>(
      `
        SELECT
          id,
          event,
          actor,
          tenant_id,
          client_ip,
          user_agent,
          correlation_id,
          body_hash,
          details,
          created_at
        FROM audit_logs
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${sqlParams.length}
      `,
      sqlParams,
    );

    const hasMore = result.rows.length > params.limit;
    const entries = result.rows.slice(0, params.limit).map(mapAuditLogRow);

    return { entries, hasMore };
  }

  private read<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (this.db) {
      return this.db.query<T>(text, params);
    }
    return readQuery<T>(text, params);
  }
}

export function createDefaultAuditLogRepository(): AuditLogRepository {
  return new PgAuditLogRepository();
}
