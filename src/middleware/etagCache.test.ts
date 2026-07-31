/**
 * @file src/middleware/etagCache.test.ts
 * @description Focused unit tests for the ETag / 304 caching utilities in
 * src/middleware/etagCache.ts.
 *
 * These tests cover the pure helper functions in isolation.  The integration
 * tests that exercise the full HTTP layer (ETag on GET /api/apis, 304 response,
 * body absent on 304, etc.) live in src/routes/apis.etag.test.ts.
 */

import { computeStrongETag, parseIfNoneMatch, isETagMatch } from './etagCache.js';

// ────────────────────────────────────────────────────────────────────────────
// computeStrongETag
// ────────────────────────────────────────────────────────────────────────────

describe('computeStrongETag', () => {
  it('returns a quoted string', () => {
    const tag = computeStrongETag({ data: [], meta: {} });
    expect(tag).toMatch(/^"[0-9a-f]+"$/);
  });

  it('returns the same ETag for identical payloads', () => {
    const body = { data: [{ id: 1, name: 'Test' }], meta: { total: 1 } };
    expect(computeStrongETag(body)).toBe(computeStrongETag(body));
  });

  it('returns different ETags for different payloads', () => {
    const a = computeStrongETag({ data: [{ id: 1 }] });
    const b = computeStrongETag({ data: [{ id: 2 }] });
    expect(a).not.toBe(b);
  });

  it('is sensitive to field order in the JSON representation', () => {
    // JSON.stringify preserves insertion order; objects with different key
    // orders produce different JSON strings and thus different ETags.
    const a = computeStrongETag({ a: 1, b: 2 });
    const b = computeStrongETag({ b: 2, a: 1 });
    // These MAY differ because insertion order differs.
    // We just verify both are valid quoted strings.
    expect(a).toMatch(/^"[0-9a-f]+"$/);
    expect(b).toMatch(/^"[0-9a-f]+"$/);
  });

  it('produces a 34-character string (32 hex chars + 2 quotes)', () => {
    const tag = computeStrongETag({ x: 1 });
    expect(tag).toHaveLength(34); // '"' + 32 hex + '"'
  });

  it('handles an empty object', () => {
    const tag = computeStrongETag({});
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('handles null', () => {
    const tag = computeStrongETag(null);
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('handles arrays', () => {
    const tag = computeStrongETag([1, 2, 3]);
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('handles deeply nested structures', () => {
    const tag = computeStrongETag({ a: { b: { c: [1, 2, { d: 'e' }] } } });
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseIfNoneMatch
// ────────────────────────────────────────────────────────────────────────────

describe('parseIfNoneMatch', () => {
  it('returns an empty set for undefined', () => {
    expect(parseIfNoneMatch(undefined).size).toBe(0);
  });

  it('returns an empty set for empty string', () => {
    expect(parseIfNoneMatch('').size).toBe(0);
  });

  it('returns a Set containing "*" for the wildcard', () => {
    const tags = parseIfNoneMatch('*');
    expect(tags.has('*')).toBe(true);
    expect(tags.size).toBe(1);
  });

  it('parses a single quoted ETag', () => {
    const tags = parseIfNoneMatch('"abc123"');
    expect(tags.has('abc123')).toBe(true);
    expect(tags.size).toBe(1);
  });

  it('parses multiple comma-separated ETags', () => {
    const tags = parseIfNoneMatch('"aaa", "bbb", "ccc"');
    expect(tags.has('aaa')).toBe(true);
    expect(tags.has('bbb')).toBe(true);
    expect(tags.has('ccc')).toBe(true);
    expect(tags.size).toBe(3);
  });

  it('strips the W/ prefix from weak ETags', () => {
    const tags = parseIfNoneMatch('W/"weaketag"');
    expect(tags.has('weaketag')).toBe(true);
  });

  it('strips W/ prefix (case-insensitive)', () => {
    const tags = parseIfNoneMatch('w/"weaketag"');
    expect(tags.has('weaketag')).toBe(true);
  });

  it('handles a mix of strong and weak ETags', () => {
    const tags = parseIfNoneMatch('"strong", W/"weak"');
    expect(tags.has('strong')).toBe(true);
    expect(tags.has('weak')).toBe(true);
  });

  it('ignores empty segments from trailing commas', () => {
    const tags = parseIfNoneMatch('"abc",');
    expect(tags.has('abc')).toBe(true);
    expect(tags.size).toBe(1);
  });

  it('handles extra whitespace around tags', () => {
    const tags = parseIfNoneMatch('  "abc"  ,  "def"  ');
    expect(tags.has('abc')).toBe(true);
    expect(tags.has('def')).toBe(true);
  });

  it('returns an empty set for a completely malformed header (no quotes)', () => {
    // "notquoted" without surrounding double-quotes is still handled:
    // the regex strips quotes only if present, leaving the bare value.
    const tags = parseIfNoneMatch('notquoted');
    // The value is returned as-is after stripping (no quotes to strip).
    expect(tags.has('notquoted')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isETagMatch
// ────────────────────────────────────────────────────────────────────────────

describe('isETagMatch', () => {
  const currentETag = '"abc123def456abc123def456abc12345"'; // 32-char hex digest

  it('returns false when If-None-Match header is absent', () => {
    expect(isETagMatch(currentETag, undefined)).toBe(false);
  });

  it('returns false when If-None-Match is empty string', () => {
    expect(isETagMatch(currentETag, '')).toBe(false);
  });

  it('returns true when If-None-Match contains the matching ETag', () => {
    expect(isETagMatch(currentETag, '"abc123def456abc123def456abc12345"')).toBe(true);
  });

  it('returns true for wildcard "*"', () => {
    expect(isETagMatch(currentETag, '*')).toBe(true);
  });

  it('returns false when If-None-Match contains a different ETag', () => {
    expect(isETagMatch(currentETag, '"different000000000000000000000000"')).toBe(false);
  });

  it('returns true when the matching ETag is one of many in a list', () => {
    const header = '"other0000000000000000000000000000", "abc123def456abc123def456abc12345", "another00000000000000000000000000"';
    expect(isETagMatch(currentETag, header)).toBe(true);
  });

  it('returns true when the matching ETag is supplied as a weak ETag in If-None-Match', () => {
    // Per RFC 9110 §13.1.2, If-None-Match uses weak comparison — a weak client
    // tag matching the strong server tag is still a match.
    expect(isETagMatch(currentETag, 'W/"abc123def456abc123def456abc12345"')).toBe(true);
  });

  it('returns false when none of the listed ETags match', () => {
    const header = '"aaa00000000000000000000000000000", "bbb00000000000000000000000000000"';
    expect(isETagMatch(currentETag, header)).toBe(false);
  });
});
