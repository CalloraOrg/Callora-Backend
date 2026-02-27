import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
