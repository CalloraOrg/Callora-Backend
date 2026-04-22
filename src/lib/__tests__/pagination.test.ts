import assert from 'node:assert/strict';
import { parsePagination, paginatedResponse } from '../pagination.js';

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

  it('clamps limit to min 1', () => {
    assert.deepEqual(parsePagination({ limit: '0' }), { limit: 1, offset: 0 });
    assert.deepEqual(parsePagination({ limit: '-5' }), { limit: 1, offset: 0 });
  });

  it('clamps offset to min 0', () => {
    assert.deepEqual(parsePagination({ offset: '-10' }), { limit: 20, offset: 0 });
  });

  it('handles non-numeric strings gracefully', () => {
    assert.deepEqual(parsePagination({ limit: 'abc', offset: 'xyz' }), { limit: 20, offset: 0 });
  });

  // --- Edge cases: undefined / empty ---

  it('returns defaults when values are explicitly undefined', () => {
    assert.deepEqual(parsePagination({ limit: undefined, offset: undefined }), { limit: 20, offset: 0 });
  });

  it('returns defaults for empty strings', () => {
    assert.deepEqual(parsePagination({ limit: '', offset: '' }), { limit: 20, offset: 0 });
  });

  it('returns defaults for whitespace-only strings', () => {
    assert.deepEqual(parsePagination({ limit: '  ', offset: '  ' }), { limit: 20, offset: 0 });
  });

  // --- Edge cases: floating-point values ---

  it('truncates floating-point limit via parseInt', () => {
    assert.deepEqual(parsePagination({ limit: '10.7' }), { limit: 10, offset: 0 });
  });

  it('truncates floating-point offset via parseInt', () => {
    assert.deepEqual(parsePagination({ offset: '5.9' }), { limit: 20, offset: 5 });
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

  it('falls back to defaults for "Infinity"', () => {
    assert.deepEqual(parsePagination({ limit: 'Infinity' }), { limit: 20, offset: 0 });
  });

  it('falls back to defaults for "NaN"', () => {
    assert.deepEqual(parsePagination({ limit: 'NaN' }), { limit: 20, offset: 0 });
  });

  it('handles leading/trailing whitespace in numeric strings', () => {
    assert.deepEqual(parsePagination({ limit: ' 50 ', offset: ' 10 ' }), { limit: 50, offset: 10 });
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
