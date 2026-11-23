import { v4 as uuidv4 } from 'uuid';
import { readQuery, writeQuery, type Queryable } from '../db.js';
import type {
  CreateQuotaRequestInput,
  QuotaRequest,
  QuotaRequestStatus,
  QuotaRequestStore,
} from './quotaService.js';

interface QuotaRequestRow {
  id: string;
  developer_id: string;
  requested_tier: string;
  reason: string;
  monthly_call_limit: number | null;
  rate_limit_max_requests: number | null;
  status: QuotaRequestStatus;
  admin_notes: string | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
  resolved_by: string | null;
}

const SELECT_COLUMNS = `
  id,
  developer_id,
  requested_tier,
  reason,
  monthly_call_limit,
  rate_limit_max_requests,
  status,
  admin_notes,
  created_at,
  resolved_at,
  resolved_by
`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: QuotaRequestRow): QuotaRequest {
  const request: QuotaRequest = {
    id: row.id,
    developerId: row.developer_id,
    requestedTier: row.requested_tier,
    reason: row.reason,
    status: row.status,
    createdAt: toDate(row.created_at),
  };

  if (row.monthly_call_limit != null || row.rate_limit_max_requests != null) {
    request.requestedOverrides = {
      ...(row.monthly_call_limit != null
        ? { monthlyCallLimit: Number(row.monthly_call_limit) }
        : {}),
      ...(row.rate_limit_max_requests != null
        ? { rateLimitMaxRequests: Number(row.rate_limit_max_requests) }
        : {}),
    };
  }

  if (row.admin_notes != null) {
    request.adminNotes = row.admin_notes;
  }
  if (row.resolved_at != null) {
    request.resolvedAt = toDate(row.resolved_at);
  }
  if (row.resolved_by != null) {
    request.resolvedBy = row.resolved_by;
  }

  return request;
}

export class PostgresQuotaRequestStore implements QuotaRequestStore {
  private readonly reader: Queryable;
  private readonly writer: Queryable;

  constructor(db?: Queryable) {
    this.reader = db ?? { query: readQuery };
    this.writer = db ?? { query: writeQuery };
  }

  async create(input: CreateQuotaRequestInput): Promise<QuotaRequest> {
    const id = uuidv4();
    const createdAt = new Date();
    const monthlyCallLimit = input.requestedOverrides?.monthlyCallLimit ?? null;
    const rateLimitMaxRequests = input.requestedOverrides?.rateLimitMaxRequests ?? null;

    const { rows } = await this.writer.query<QuotaRequestRow>(
      `
      INSERT INTO quota_requests (
        id,
        developer_id,
        requested_tier,
        reason,
        monthly_call_limit,
        rate_limit_max_requests,
        status,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
      RETURNING ${SELECT_COLUMNS}
      `,
      [
        id,
        input.developerId,
        input.requestedTier,
        input.reason,
        monthlyCallLimit,
        rateLimitMaxRequests,
        createdAt,
      ],
    );

    return mapRow(rows[0]!);
  }

  async findById(id: string): Promise<QuotaRequest | undefined> {
    const { rows } = await this.reader.query<QuotaRequestRow>(
      `SELECT ${SELECT_COLUMNS} FROM quota_requests WHERE id = $1`,
      [id],
    );

    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async list(filter?: { status?: QuotaRequestStatus }): Promise<QuotaRequest[]> {
    if (filter?.status) {
      const { rows } = await this.reader.query<QuotaRequestRow>(
        `SELECT ${SELECT_COLUMNS} FROM quota_requests WHERE status = $1 ORDER BY created_at ASC`,
        [filter.status],
      );
      return rows.map(mapRow);
    }

    const { rows } = await this.reader.query<QuotaRequestRow>(
      `SELECT ${SELECT_COLUMNS} FROM quota_requests ORDER BY created_at ASC`,
    );
    return rows.map(mapRow);
  }

  async update(
    id: string,
    changes: Partial<QuotaRequest>,
  ): Promise<QuotaRequest | undefined> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (changes.developerId !== undefined) {
      setClauses.push(`developer_id = $${paramIndex++}`);
      params.push(changes.developerId);
    }
    if (changes.requestedTier !== undefined) {
      setClauses.push(`requested_tier = $${paramIndex++}`);
      params.push(changes.requestedTier);
    }
    if (changes.reason !== undefined) {
      setClauses.push(`reason = $${paramIndex++}`);
      params.push(changes.reason);
    }
    if (changes.requestedOverrides !== undefined) {
      setClauses.push(`monthly_call_limit = $${paramIndex++}`);
      params.push(changes.requestedOverrides.monthlyCallLimit ?? null);
      setClauses.push(`rate_limit_max_requests = $${paramIndex++}`);
      params.push(changes.requestedOverrides.rateLimitMaxRequests ?? null);
    }
    if (changes.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(changes.status);
    }
    if (changes.adminNotes !== undefined) {
      setClauses.push(`admin_notes = $${paramIndex++}`);
      params.push(changes.adminNotes);
    }
    if (changes.resolvedAt !== undefined) {
      setClauses.push(`resolved_at = $${paramIndex++}`);
      params.push(changes.resolvedAt);
    }
    if (changes.resolvedBy !== undefined) {
      setClauses.push(`resolved_by = $${paramIndex++}`);
      params.push(changes.resolvedBy);
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    params.push(id);
    const { rows } = await this.writer.query<QuotaRequestRow>(
      `
      UPDATE quota_requests
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING ${SELECT_COLUMNS}
      `,
      params,
    );

    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}
