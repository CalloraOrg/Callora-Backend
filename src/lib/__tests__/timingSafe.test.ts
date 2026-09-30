import { timingSafeEqual } from 'node:crypto';
import { parseBearerToken, timingSafeStringEqual } from '../timingSafe.js';

// Wrap (not replace) the real implementation so its calls can be inspected.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

// #1266: shared constant-time comparison used by /api/metrics and adminAuth.

describe('timingSafeStringEqual', () => {
  it('returns true only for identical strings', () => {
    expect(timingSafeStringEqual('s3cret-key', 's3cret-key')).toBe(true);
    expect(timingSafeStringEqual('', '')).toBe(true);
    expect(timingSafeStringEqual('s3cret-key', 's3cret-kez')).toBe(false);
    expect(timingSafeStringEqual('s3cret-key', 'S3cret-key')).toBe(false);
  });

  it('rejects prefixes, suffixes and different lengths', () => {
    expect(timingSafeStringEqual('s3cret-key', 's3cret')).toBe(false);
    expect(timingSafeStringEqual('s3cret', 's3cret-key')).toBe(false);
    expect(timingSafeStringEqual('s3cret-key', 's3cret-key ')).toBe(false);
    expect(timingSafeStringEqual('abc', '')).toBe(false);
  });

  it('handles multi-byte characters by bytes, not code units', () => {
    expect(timingSafeStringEqual('clé-🔑', 'clé-🔑')).toBe(true);
    expect(timingSafeStringEqual('clé', 'cle')).toBe(false);
  });

  it('always compares fixed-length digests with crypto.timingSafeEqual', () => {
    const spy = timingSafeEqual as unknown as jest.Mock;
    spy.mockClear();
    expect(timingSafeStringEqual('a', 'a-much-longer-candidate-value')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [left, right] = spy.mock.calls[0] as [Buffer, Buffer];
    // Equal 32-byte buffers regardless of input lengths: no length leak.
    expect(left.length).toBe(32);
    expect(right.length).toBe(32);
  });
});

describe('parseBearerToken', () => {
  it('extracts the token from a Bearer header (scheme case-insensitive)', () => {
    expect(parseBearerToken('Bearer abc123')).toBe('abc123');
    expect(parseBearerToken('bearer abc123')).toBe('abc123');
    expect(parseBearerToken('BEARER   abc123  ')).toBe('abc123');
  });

  it('returns null for missing, malformed or non-Bearer headers', () => {
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc123', 'abc123', 'Bearer a b']) {
      expect(parseBearerToken(header)).toBeNull();
    }
    expect(parseBearerToken(['Bearer abc123'])).toBeNull();
  });
});
