/**
 * Tests for the correlation-id middleware.
 *
 * Covers:
 *   - Incoming x-correlation-id header is propagated to the response
 *   - Fallback to req.id when no correlation-id header is present
 *   - UUID generation when neither header nor req.id is available
 *   - Sanitisation: control characters stripped, oversized values rejected
 *   - req.correlationId is attached for downstream handlers
 *   - X-Correlation-Id header is always set on the response
 *   - Array header values are handled correctly
 */

import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import {
  correlationMiddleware,
  resolveCorrelationId,
  sanitizeCorrelationId,
  CORRELATION_ID_HEADER,
} from './correlation.js';

// ---------------------------------------------------------------------------
// sanitizeCorrelationId
// ---------------------------------------------------------------------------

describe('sanitizeCorrelationId', () => {
  test('returns the value unchanged for a normal id', () => {
    assert.equal(sanitizeCorrelationId('corr-abc-123'), 'corr-abc-123');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(sanitizeCorrelationId('  test-trim  '), 'test-trim');
  });

  test('strips CR and LF to prevent header injection', () => {
    assert.equal(sanitizeCorrelationId('id\r\nX-Evil: injected'), 'idX-Evil: injected');
  });

  test('strips all ASCII control characters', () => {
    assert.equal(sanitizeCorrelationId('id\x00\x01\x1F\x7F'), 'id');
  });

  test('returns undefined for empty string', () => {
    assert.equal(sanitizeCorrelationId(''), undefined);
  });

  test('returns undefined for whitespace-only string', () => {
    assert.equal(sanitizeCorrelationId('   '), undefined);
  });

  test('returns undefined for undefined input', () => {
    assert.equal(sanitizeCorrelationId(undefined), undefined);
  });

  test('returns undefined when value exceeds max length', () => {
    const oversized = 'a'.repeat(129);
    assert.equal(sanitizeCorrelationId(oversized), undefined);
  });

  test('accepts value at exactly max length', () => {
    const maxLen = 'a'.repeat(128);
    assert.equal(sanitizeCorrelationId(maxLen), maxLen);
  });
});

// ---------------------------------------------------------------------------
// resolveCorrelationId
// ---------------------------------------------------------------------------

describe('resolveCorrelationId', () => {
  test('prefers incoming x-correlation-id header', () => {
    const req = {
      headers: { 'x-correlation-id': 'client-corr-123' },
      id: 'req-id-456',
    } as unknown as Request;

    assert.equal(resolveCorrelationId(req), 'client-corr-123');
  });

  test('falls back to req.id when no header is present', () => {
    const req = {
      headers: {},
      id: 'req-id-789',
    } as unknown as Request;

    assert.equal(resolveCorrelationId(req), 'req-id-789');
  });

  test('generates a UUID when neither header nor req.id is available', () => {
    const req = {
      headers: {},
    } as unknown as Request;

    const result = resolveCorrelationId(req);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(result, uuidRegex);
  });

  test('sanitises the incoming header value', () => {
    const req = {
      headers: { 'x-correlation-id': '  safe-id  ' },
    } as unknown as Request;

    assert.equal(resolveCorrelationId(req), 'safe-id');
  });

  test('ignores oversized header and falls back to req.id', () => {
    const req = {
      headers: { 'x-correlation-id': 'x'.repeat(129) },
      id: 'fallback-id',
    } as unknown as Request;

    assert.equal(resolveCorrelationId(req), 'fallback-id');
  });

  test('handles array header values', () => {
    const req = {
      headers: { 'x-correlation-id': ['first-value', 'second-value'] },
      id: 'req-id',
    } as unknown as Request;

    assert.equal(resolveCorrelationId(req), 'first-value');
  });
});

// ---------------------------------------------------------------------------
// correlationMiddleware
// ---------------------------------------------------------------------------

describe('correlationMiddleware', () => {
  test('propagates incoming x-correlation-id to response header', (done) => {
    const req = {
      headers: { 'x-correlation-id': 'client-corr-abc' },
      id: 'req-1',
    } as unknown as Request;

    let responseHeaderValue: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === 'X-Correlation-Id') {
          responseHeaderValue = value;
        }
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal(responseHeaderValue, 'client-corr-abc');
      assert.equal(
        (req as Request & { correlationId?: string }).correlationId,
        'client-corr-abc',
      );
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('falls back to req.id when no correlation-id header is present', (done) => {
    const req = {
      headers: {},
      id: 'req-fallback-42',
    } as unknown as Request;

    let responseHeaderValue: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === 'X-Correlation-Id') {
          responseHeaderValue = value;
        }
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal(responseHeaderValue, 'req-fallback-42');
      assert.equal(
        (req as Request & { correlationId?: string }).correlationId,
        'req-fallback-42',
      );
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('generates a UUID when neither header nor req.id is available', (done) => {
    const req = {
      headers: {},
    } as unknown as Request;

    let responseHeaderValue: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === 'X-Correlation-Id') {
          responseHeaderValue = value;
        }
      },
    } as unknown as Response;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const next = (() => {
      assert.ok(responseHeaderValue, 'X-Correlation-Id header must be set');
      assert.match(responseHeaderValue ?? '', uuidRegex);
      assert.match(
        (req as Request & { correlationId?: string }).correlationId ?? '',
        uuidRegex,
      );
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('sanitises the incoming header before setting response', (done) => {
    const req = {
      headers: { 'x-correlation-id': '  trimmed-id  ' },
      id: 'req-2',
    } as unknown as Request;

    let responseHeaderValue: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === 'X-Correlation-Id') {
          responseHeaderValue = value;
        }
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal(responseHeaderValue, 'trimmed-id');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('rejects oversized header and generates fallback', (done) => {
    const oversized = 'x'.repeat(129);
    const req = {
      headers: { 'x-correlation-id': oversized },
      id: 'req-3',
    } as unknown as Request;

    let responseHeaderValue: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === 'X-Correlation-Id') {
          responseHeaderValue = value;
        }
      },
    } as unknown as Response;

    const next = (() => {
      // Oversized header should be ignored, falls back to req.id
      assert.equal(responseHeaderValue, 'req-3');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('always sets X-Correlation-Id on the response', (done) => {
    const req = {
      headers: {},
    } as unknown as Request;

    const headerCalls: Array<{ name: string; value: string }> = [];
    const res = {
      setHeader: (name: string, value: string) => {
        headerCalls.push({ name, value });
      },
    } as unknown as Response;

    const next = (() => {
      const correlationHeader = headerCalls.find(
        (c) => c.name === 'X-Correlation-Id',
      );
      assert.ok(correlationHeader, 'X-Correlation-Id must be set on response');
      assert.ok(correlationHeader!.value.length > 0);
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });
});
