import assert from 'node:assert/strict';
import { parsePagination, paginatedResponse } from '../pagination';
import { ValidationError } from '../../middleware/validate';

function assertValidationError(fn: () => unknown, field: string) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
    assert.ok(
      err.details.some((d) => d.field === field),
      `expected field "${field}" in details: ${JSON.stringify(err.details)}`,
    );
    return true;
  });
}

describe('parsePagination', () => {
  // --- Defaults ---

  it('returns defaults when no query params given', () => {
    assert.deepEqual(parsePagination({}), { limit: 20, offset: 0 });
  });

  it('returns defaults when values are explicitly undefined', () => {
    assert.deepEqual(parsePagination({ limit: undefined, offset: undefined }), { limit: 20, offset: 0 });
  });

  it('returns defaults for empty strings', () => {
    assert.deepEqual(parsePagination({ limit: '', offset: '' }), { limit: 20, offset: 0 });
  });

  it('returns defaults for whitespace-only strings', () => {
    assert.deepEqual(parsePagination({ limit: '  ', offset: '  ' }), { limit: 20, offset: 0 });
  });

  // --- Valid values ---

  it('parses valid limit and offset', () => {
    assert.deepEqual(parsePagination({ limit: '10', offset: '30' }), { limit: 10, offset: 30 });
  });

  it('accepts limit at lower boundary (1)', () => {
    assert.deepEqual(parsePagination({ limit: '1' }), { limit: 1, offset: 0 });
  });

  it('accepts limit at upper boundary (100)', () => {
    assert.deepEqual(parsePagination({ limit: '100' }), { limit: 100, offset: 0 });
  });

  it('clamps limit above max to 100', () => {
    assert.deepEqual(parsePagination({ limit: '500' }), { limit: 100, offset: 0 });
  });

  it('clamps a huge limit (Number.MAX_SAFE_INTEGER) to 100', () => {
    assert.deepEqual(parsePagination({ limit: '9007199254740991' }), { limit: 100, offset: 0 });
  });

  it('accepts offset at lower boundary (0)', () => {
    assert.deepEqual(parsePagination({ offset: '0' }), { limit: 20, offset: 0 });
  });

  it('allows a large offset value', () => {
    assert.deepEqual(parsePagination({ offset: '999999999' }), { limit: 20, offset: 999999999 });
  });

  it('handles leading/trailing whitespace in numeric strings', () => {
    assert.deepEqual(parsePagination({ limit: ' 50 ', offset: ' 10 ' }), { limit: 50, offset: 10 });
  });

  // --- Strict rejection: non-integer strings ---

  it('rejects non-numeric limit with 400', () => {
    assertValidationError(() => parsePagination({ limit: 'abc' }), 'query.limit');
  });

  it('rejects non-numeric offset with 400', () => {
    assertValidationError(() => parsePagination({ offset: 'xyz' }), 'query.offset');
  });

  it('rejects floating-point limit', () => {
    assertValidationError(() => parsePagination({ limit: '10.7' }), 'query.limit');
  });

  it('rejects fractional limit even when the fractional part is zero', () => {
    assertValidationError(() => parsePagination({ limit: '10.0' }), 'query.limit');
  });

  it('rejects scientific notation for limit', () => {
    assertValidationError(() => parsePagination({ limit: '1e2' }), 'query.limit');
  });

  it('rejects hexadecimal notation for limit', () => {
    assertValidationError(() => parsePagination({ limit: '0x10' }), 'query.limit');
  });

  it('rejects floating-point offset', () => {
    assertValidationError(() => parsePagination({ offset: '5.9' }), 'query.offset');
  });

  it('rejects "Infinity" for limit', () => {
    assertValidationError(() => parsePagination({ limit: 'Infinity' }), 'query.limit');
  });

  it('rejects "NaN" for limit', () => {
    assertValidationError(() => parsePagination({ limit: 'NaN' }), 'query.limit');
  });

  // --- Strict rejection: out-of-range ---

  it('rejects limit=0 (below min 1)', () => {
    assertValidationError(() => parsePagination({ limit: '0' }), 'query.limit');
  });

  it('rejects negative limit', () => {
    assertValidationError(() => parsePagination({ limit: '-5' }), 'query.limit');
  });

  it('rejects negative offset', () => {
    assertValidationError(() => parsePagination({ offset: '-10' }), 'query.offset');
  });

  // --- Page parameter: valid ---

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

  // --- Page parameter: strict rejection ---

  it('rejects non-numeric page', () => {
    assertValidationError(() => parsePagination({ page: 'abc' }), 'query.page');
  });

  it('rejects page=0 (below min 1)', () => {
    assertValidationError(() => parsePagination({ page: '0' }), 'query.page');
  });

  it('rejects negative page', () => {
    assertValidationError(() => parsePagination({ page: '-5' }), 'query.page');
  });

  it('rejects floating-point page', () => {
    assertValidationError(() => parsePagination({ page: '2.9' }), 'query.page');
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
