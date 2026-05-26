import { BadRequestError } from '../errors/index.js';

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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type PaginationField = 'limit' | 'offset' | 'page';

export class PaginationParseError extends BadRequestError {
  constructor(public readonly field: PaginationField, message: string) {
    super(message, 'INVALID_PAGINATION');
    this.name = 'PaginationParseError';
    Object.setPrototypeOf(this, PaginationParseError.prototype);
  }
}

function parseIntegerParam(
  field: PaginationField,
  value: string | undefined,
  min: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new PaginationParseError(field, `${field} must be an integer greater than or equal to ${min}`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new PaginationParseError(field, `${field} must be an integer greater than or equal to ${min}`);
  }

  return parsed;
}

export function parsePagination(query: {
  limit?: string;
  offset?: string;
  page?: string;
}): PaginationParams {
  const parsedLimit = parseIntegerParam('limit', query.limit, 1);
  const limit = Math.min(MAX_LIMIT, parsedLimit ?? DEFAULT_LIMIT);

  let offset = 0;
  if (query.page !== undefined) {
    const page = parseIntegerParam('page', query.page, 1) ?? 1;
    offset = (page - 1) * limit;
  } else {
    offset = parseIntegerParam('offset', query.offset, 0) ?? 0;
  }

  return { limit, offset };
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
