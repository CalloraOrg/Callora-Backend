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

export function parsePagination(query: {
  limit?: string;
  offset?: string;
}): PaginationParams {
  const parsedLimit = parseInt(query.limit ?? '', 10);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit),
  );

  const parsedOffset = parseInt(query.offset ?? '', 10);
  const offset = Math.max(0, Number.isNaN(parsedOffset) ? 0 : parsedOffset);

  return { limit, offset };
}

export function paginatedResponse<T>(
  data: T[],
  meta: PaginationMeta,
): PaginatedResponse<T> {
  return { data, meta };
}
