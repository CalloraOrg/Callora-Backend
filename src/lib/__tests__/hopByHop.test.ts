/**
 * Unit tests for hop-by-hop header utilities (RFC 7230 §6.1).
 */

import {
  STATIC_HOP_BY_HOP,
  buildHopByHopSet,
  stripHopByHopHeaders,
} from '../hopByHop.js';

// ── STATIC_HOP_BY_HOP ─────────────────────────────────────────────────────────

describe('STATIC_HOP_BY_HOP', () => {
  const required = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ];

  test.each(required)('contains "%s"', (header) => {
    expect(STATIC_HOP_BY_HOP.has(header)).toBe(true);
  });

  it('does not contain safe application headers', () => {
    expect(STATIC_HOP_BY_HOP.has('content-type')).toBe(false);
    expect(STATIC_HOP_BY_HOP.has('authorization')).toBe(false);
    expect(STATIC_HOP_BY_HOP.has('x-request-id')).toBe(false);
    expect(STATIC_HOP_BY_HOP.has('cache-control')).toBe(false);
  });
});

// ── buildHopByHopSet ──────────────────────────────────────────────────────────

describe('buildHopByHopSet', () => {
  it('returns the static set when Connection header is absent', () => {
    const set = buildHopByHopSet(undefined);
    expect(set).toBe(STATIC_HOP_BY_HOP);
  });

  it('returns the static set when Connection header is null', () => {
    const set = buildHopByHopSet(null);
    expect(set).toBe(STATIC_HOP_BY_HOP);
  });

  it('adds a single extra header from Connection value', () => {
    const set = buildHopByHopSet('x-custom-hop');
    expect(set.has('x-custom-hop')).toBe(true);
    expect(set.has('connection')).toBe(true); // static still present
  });

  it('adds multiple extra headers from Connection value', () => {
    const set = buildHopByHopSet('x-foo, x-bar, x-baz');
    expect(set.has('x-foo')).toBe(true);
    expect(set.has('x-bar')).toBe(true);
    expect(set.has('x-baz')).toBe(true);
  });

  it('normalises extra header names to lower-case', () => {
    const set = buildHopByHopSet('X-Custom-Hop, ANOTHER-HOP');
    expect(set.has('x-custom-hop')).toBe(true);
    expect(set.has('another-hop')).toBe(true);
  });

  it('trims whitespace around token names', () => {
    const set = buildHopByHopSet('  x-padded  ,  x-also-padded  ');
    expect(set.has('x-padded')).toBe(true);
    expect(set.has('x-also-padded')).toBe(true);
  });

  it('does not mutate STATIC_HOP_BY_HOP', () => {
    const before = new Set(STATIC_HOP_BY_HOP);
    buildHopByHopSet('x-new-header');
    expect(new Set(STATIC_HOP_BY_HOP)).toEqual(before);
  });

  it('handles empty Connection value gracefully', () => {
    const set = buildHopByHopSet('');
    // Empty string produces one empty token which is ignored
    expect(set.has('connection')).toBe(true);
  });
});

// ── stripHopByHopHeaders ──────────────────────────────────────────────────────

describe('stripHopByHopHeaders', () => {
  it('removes all static hop-by-hop headers', () => {
    const input: Record<string, string> = {
      'connection': 'keep-alive',
      'keep-alive': 'timeout=5',
      'proxy-authenticate': 'Basic realm="proxy"',
      'proxy-authorization': 'Basic abc',
      'proxy-connection': 'keep-alive',
      'te': 'trailers',
      'trailer': 'Expires',
      'transfer-encoding': 'chunked',
      'upgrade': 'websocket',
      'content-type': 'application/json',
      'x-request-id': 'abc-123',
    };

    const result = stripHopByHopHeaders(input);

    expect(result['connection']).toBeUndefined();
    expect(result['keep-alive']).toBeUndefined();
    expect(result['proxy-authenticate']).toBeUndefined();
    expect(result['proxy-authorization']).toBeUndefined();
    expect(result['proxy-connection']).toBeUndefined();
    expect(result['te']).toBeUndefined();
    expect(result['trailer']).toBeUndefined();
    expect(result['transfer-encoding']).toBeUndefined();
    expect(result['upgrade']).toBeUndefined();
  });

  it('preserves safe application headers', () => {
    const input: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': 'Bearer token',
      'x-request-id': 'abc-123',
      'cache-control': 'no-cache',
      'accept': 'application/json',
    };

    const result = stripHopByHopHeaders(input);

    expect(result['content-type']).toBe('application/json');
    expect(result['authorization']).toBe('Bearer token');
    expect(result['x-request-id']).toBe('abc-123');
    expect(result['cache-control']).toBe('no-cache');
    expect(result['accept']).toBe('application/json');
  });

  it('strips headers listed in Connection value (dynamic hop-by-hop)', () => {
    const input: Record<string, string> = {
      'connection': 'x-custom-hop, x-another-hop',
      'x-custom-hop': 'should-be-stripped',
      'x-another-hop': 'also-stripped',
      'x-safe': 'should-remain',
    };

    const result = stripHopByHopHeaders(input);

    expect(result['x-custom-hop']).toBeUndefined();
    expect(result['x-another-hop']).toBeUndefined();
    expect(result['x-safe']).toBe('should-remain');
  });

  it('is case-insensitive for header names', () => {
    const input: Record<string, string> = {
      'Transfer-Encoding': 'chunked',
      'KEEP-ALIVE': 'timeout=5',
      'Upgrade': 'websocket',
      'Content-Type': 'application/json',
    };

    const result = stripHopByHopHeaders(input);

    expect(result['Transfer-Encoding']).toBeUndefined();
    expect(result['KEEP-ALIVE']).toBeUndefined();
    expect(result['Upgrade']).toBeUndefined();
    expect(result['Content-Type']).toBe('application/json');
  });

  it('returns an empty object when all headers are hop-by-hop', () => {
    const input: Record<string, string> = {
      'connection': 'close',
      'transfer-encoding': 'chunked',
    };
    const result = stripHopByHopHeaders(input);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns a copy — does not mutate the input', () => {
    const input: Record<string, string> = {
      'connection': 'close',
      'content-type': 'application/json',
    };
    const inputCopy = { ...input };
    stripHopByHopHeaders(input);
    expect(input).toEqual(inputCopy);
  });
});
