import { ValidationError } from '../middleware/validate.js';

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginationMeta {
  total?: number;
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface CursorPaginationParams {
  limit: number;
  cursor?: string;
}

export interface CursorPaginationMeta {
  limit: number;
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
}

export interface CursorPaginatedResponse<T> {
  data: T[];
  meta: CursorPaginationMeta;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Returns true if the string is absent or empty (treat as "use default").
 * Returns false if the string is present but not a valid non-negative integer.
 * Throws ValidationError for present-but-invalid values.
 */
function parseIntParam(
  raw: string | undefined,
  field: string,
  { min, max }: { min?: number; max?: number } = {},
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const trimmed = raw.trim();
  // Must be a string of digits only (no sign, no decimal, no exponent)
  if (!/^\d+$/.test(trimmed)) {
    throw new ValidationError([
      { field: `query.${field}`, message: `${field} must be a non-negative integer`, code: 'INVALID_VALUE' },
    ]);
  }

  const value = parseInt(trimmed, 10);

  if (min !== undefined && value < min) {
    throw new ValidationError([
      { field: `query.${field}`, message: `${field} must be >= ${min}`, code: 'INVALID_VALUE' },
    ]);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError([
      { field: `query.${field}`, message: `${field} must be <= ${max}`, code: 'INVALID_VALUE' },
    ]);
  }

  return value;
}

/**
 * Parses and strictly validates pagination query parameters.
 *
 * - `limit`: optional non-negative integer, clamped to [1, MAX_LIMIT]. Defaults to DEFAULT_LIMIT.
 * - `offset`: optional non-negative integer. Defaults to 0.
 * - `page`: optional non-negative integer >= 1. When present, takes precedence over `offset`.
 *
 * Throws a ValidationError (400) when a supplied value is non-integer or negative.
 */
export function parsePagination(query: {
  limit?: string;
  offset?: string;
  page?: string;
}): PaginationParams {
  const rawLimit = parseIntParam(query.limit, 'limit', { min: 1 });
  const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  let offset = 0;
  if (query.page !== undefined && query.page.trim() !== '') {
    const page = parseIntParam(query.page, 'page', { min: 1 }) ?? 1;
    offset = (page - 1) * limit;
  } else {
    offset = parseIntParam(query.offset, 'offset', { min: 0 }) ?? 0;
  }

  return { limit, offset };
}

/**
 * Parse cursor-based pagination parameters
 * Supports cursor parameter for keyset pagination
 */
export function parseCursorPagination(query: {
  limit?: string;
  cursor?: string;
}): CursorPaginationParams {
  const rawLimit = parseIntParam(query.limit, 'limit', { min: 1 });
  const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  let cursor: string | undefined;
  if (query.cursor !== undefined && query.cursor.trim() !== '') {
    cursor = query.cursor.trim();
  }

  return { limit, cursor };
}

/**
 * Validate and decode cursor
 * Cursor format: base64(created_at|id)
 * Returns { created_at, id } or throws ValidationError
 */
export function decodeCursor(cursor: string): { created_at: string; id: string } {
  try {
    // Decode base64
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    
    // Split by pipe
    const parts = decoded.split('|');
    if (parts.length !== 2) {
      throw new Error('Invalid cursor format');
    }

    const [created_at, id] = parts;
    
    if (!created_at || !id) {
      throw new Error('Invalid cursor format: missing required fields');
    }

    // Validate timestamp format
    const date = new Date(created_at);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid timestamp in cursor');
    }

    return { created_at, id };
  } catch (error) {
    throw new ValidationError([
      { 
        field: 'query.cursor', 
        message: 'Invalid cursor format. Must be base64 encoded string of created_at|id', 
        code: 'INVALID_VALUE' 
      },
    ]);
  }
}

/**
 * Generate cursor for next page
 * Format: base64(created_at|id)
 */
export function generateCursor(created_at: string, id: string): string {
  return Buffer.from(`${created_at}|${id}`).toString('base64');
}

/**
 * Check if there are more results beyond the fetched limit
 */
export function hasMoreResults<T>(results: T[], limit: number): boolean {
  return results.length > limit;
}

/**
 * Extract next cursor from results
 * Assumes results are sorted by created_at DESC, id DESC
 */
export function getNextCursor<T extends { created_at: string | Date; id: string }>(
  results: T[],
  limit: number
): string | undefined {
  if (results.length > limit) {
    const lastItem = results[limit - 1];
    const created_at = typeof lastItem.created_at === 'string' 
      ? lastItem.created_at 
      : lastItem.created_at.toISOString();
    return generateCursor(created_at, lastItem.id);
  }
  return undefined;
}

export function paginatedResponse<T>(
  data: T[],
  meta: PaginationMeta,
): PaginatedResponse<T> {
  // Performance optimization: truncate large lists in-place to reduce allocations.
  // Setting length is faster than slice() as it avoids creating a new array.
  if (data.length > meta.limit) {
    data.length = meta.limit;
  }
  return { data, meta };
}

export function cursorPaginatedResponse<T>(
  data: T[],
  meta: CursorPaginationMeta,
): CursorPaginatedResponse<T> {
  // Truncate to limit
  if (data.length > meta.limit) {
    data.length = meta.limit;
  }
  return { data, meta };
} 
