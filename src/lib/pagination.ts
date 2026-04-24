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
  page?: string;
}): PaginationParams {
  const parsedLimit = parseInt(query.limit ?? '', 10);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit),
  );

  let offset = 0;
  if (query.page) {
    const parsedPage = parseInt(query.page, 10);
    const page = Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage);
    offset = (page - 1) * limit;
  } else {
    const parsedOffset = parseInt(query.offset ?? '', 10);
    offset = Math.max(0, Number.isNaN(parsedOffset) ? 0 : parsedOffset);
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
