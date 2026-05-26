import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePagination, PaginationParseError, paginatedResponse } from '../pagination.js';

function assertPaginationError(
  query: Parameters<typeof parsePagination>[0],
  field: 'limit' | 'offset' | 'page',
) {
  assert.throws(
    () => parsePagination(query),
    (error: unknown) =>
      error instanceof PaginationParseError &&
      error.field === field &&
      error.statusCode === 400 &&
      error.message.includes(field),
  );
}

describe('parsePagination', () => {
  it('returns defaults when no query params given', () => {
    assert.deepEqual(parsePagination({}), { limit: 20, offset: 0 });
  });

  it('parses valid limit and offset', () => {
    assert.deepEqual(parsePagination({ limit: '10', offset: '30' }), { limit: 10, offset: 30 });
  });

  it('clamps limit to max 100', () => {
    assert.deepEqual(parsePagination({ limit: '500' }), { limit: 100, offset: 0 });
  });

  it('rejects zero and negative limits', () => {
    assertPaginationError({ limit: '0' }, 'limit');
    assertPaginationError({ limit: '-5' }, 'limit');
  });

  it('rejects negative offsets', () => {
    assertPaginationError({ offset: '-10' }, 'offset');
  });

  it('rejects non-numeric strings with the offending field', () => {
    assertPaginationError({ limit: 'abc' }, 'limit');
    assertPaginationError({ offset: 'xyz' }, 'offset');
  });

  // --- Edge cases: undefined / empty ---

  it('returns defaults when values are explicitly undefined', () => {
    assert.deepEqual(parsePagination({ limit: undefined, offset: undefined }), { limit: 20, offset: 0 });
  });

  it('rejects empty strings when provided', () => {
    assertPaginationError({ limit: '' }, 'limit');
    assertPaginationError({ offset: '' }, 'offset');
  });

  it('rejects whitespace-only strings when provided', () => {
    assertPaginationError({ limit: '  ' }, 'limit');
    assertPaginationError({ offset: '  ' }, 'offset');
  });

  // --- Edge cases: floating-point values ---

  it('rejects floating-point limits', () => {
    assertPaginationError({ limit: '10.7' }, 'limit');
  });

  it('rejects floating-point offsets', () => {
    assertPaginationError({ offset: '5.9' }, 'offset');
  });

  // --- Edge cases: huge values (prevent unbounded queries) ---

  it('clamps a huge limit (Number.MAX_SAFE_INTEGER) to 100', () => {
    assert.deepEqual(parsePagination({ limit: '9007199254740991' }), { limit: 100, offset: 0 });
  });

  it('allows a large offset value', () => {
    assert.deepEqual(parsePagination({ offset: '999999999' }), { limit: 20, offset: 999999999 });
  });

  // --- Edge cases: exact boundaries ---

  it('accepts limit at lower boundary (1)', () => {
    assert.deepEqual(parsePagination({ limit: '1' }), { limit: 1, offset: 0 });
  });

  it('accepts limit at upper boundary (100)', () => {
    assert.deepEqual(parsePagination({ limit: '100' }), { limit: 100, offset: 0 });
  });

  it('clamps limit just above upper boundary (101)', () => {
    assert.deepEqual(parsePagination({ limit: '101' }), { limit: 100, offset: 0 });
  });

  it('accepts offset at lower boundary (0)', () => {
    assert.deepEqual(parsePagination({ offset: '0' }), { limit: 20, offset: 0 });
  });

  // --- Edge cases: special strings ---

  it('rejects "Infinity"', () => {
    assertPaginationError({ limit: 'Infinity' }, 'limit');
  });

  it('rejects "NaN"', () => {
    assertPaginationError({ limit: 'NaN' }, 'limit');
  });

  it('handles leading/trailing whitespace in numeric strings', () => {
    assert.deepEqual(parsePagination({ limit: ' 50 ', offset: ' 10 ' }), { limit: 50, offset: 10 });
  });

  // --- Page parameter tests ---

  it('calculates offset based on page and limit', () => {
    assert.deepEqual(parsePagination({ limit: '10', page: '1' }), { limit: 10, offset: 0 });
    assert.deepEqual(parsePagination({ limit: '10', page: '2' }), { limit: 10, offset: 10 });
    assert.deepEqual(parsePagination({ limit: '25', page: '3' }), { limit: 25, offset: 50 });
  });

  it('uses default limit when only page is provided', () => {
    assert.deepEqual(parsePagination({ page: '1' }), { limit: 20, offset: 0 });
    assert.deepEqual(parsePagination({ page: '2' }), { limit: 20, offset: 20 });
  });

  it('prefers page over offset when both are provided', () => {
    assert.deepEqual(parsePagination({ limit: '10', page: '2', offset: '50' }), { limit: 10, offset: 10 });
  });

  it('rejects invalid page values', () => {
    assertPaginationError({ page: 'abc' }, 'page');
    assertPaginationError({ page: '0' }, 'page');
    assertPaginationError({ page: '-5' }, 'page');
  });

  it('rejects floating-point page values', () => {
    assertPaginationError({ page: '2.9' }, 'page');
  });
});

describe('paginatedResponse', () => {
  it('wraps data and meta into the envelope', () => {
    const result = paginatedResponse([{ id: '1' }], { total: 1, limit: 20, offset: 0 });
    assert.deepEqual(result, {
      data: [{ id: '1' }],
      meta: { total: 1, limit: 20, offset: 0 },
    });
  });

  it('works without total in meta', () => {
    const result = paginatedResponse([], { limit: 20, offset: 0 });
    assert.deepEqual(result, {
      data: [],
      meta: { limit: 20, offset: 0 },
    });
    assert.equal('total' in result.meta, false);
  });

  // --- Edge cases: stable output keys ---

  it('returns exactly "data" and "meta" top-level keys', () => {
    const result = paginatedResponse([1, 2, 3], { total: 3, limit: 10, offset: 0 });
    assert.deepEqual(Object.keys(result).sort(), ['data', 'meta']);
  });

  it('includes "total", "limit", and "offset" in meta keys when total is present', () => {
    const result = paginatedResponse([], { total: 0, limit: 20, offset: 0 });
    assert.deepEqual(Object.keys(result.meta).sort(), ['limit', 'offset', 'total']);
  });

  it('includes only "limit" and "offset" in meta keys when total is omitted', () => {
    const result = paginatedResponse([], { limit: 20, offset: 0 });
    assert.deepEqual(Object.keys(result.meta).sort(), ['limit', 'offset']);
  });

  // --- Edge cases: data truncation optimization ---
  
  it('truncates a large dataset to the limit in-place', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = paginatedResponse(items, { total: 1000, limit: 100, offset: 0 });
    
    // Should be truncated to limit
    assert.equal(result.data.length, 100);
    assert.deepEqual(result.data[0], { id: 0 });
    assert.deepEqual(result.data[99], { id: 99 });
    
    // Verify in-place mutation (allocation reduction)
    assert.equal(items.length, 100);
  });

  it('does not mutate or truncate if data is within limit', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const result = paginatedResponse(items, { total: 50, limit: 100, offset: 0 });
    
    assert.equal(result.data.length, 50);
    assert.equal(items.length, 50);
    assert.strictEqual(result.data, items);
  });

  it('handles an empty data array with non-zero offset', () => {
    const result = paginatedResponse([], { total: 50, limit: 10, offset: 100 });
    assert.deepEqual(result.data, []);
    assert.equal(result.meta.total, 50);
    assert.equal(result.meta.offset, 100);
  });
});
