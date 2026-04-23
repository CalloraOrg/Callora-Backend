import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { getRequestId } from '../logger.js';
import { requestIdMiddleware, sanitizeRequestId, REQUEST_ID_MAX_LENGTH } from './requestId.js';

describe('sanitizeRequestId', () => {
  test('returns the value unchanged for a normal id', () => {
    assert.equal(sanitizeRequestId('trace-abc-123'), 'trace-abc-123');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(sanitizeRequestId('  test-trim-id  '), 'test-trim-id');
  });

  test('strips CR and LF to prevent header injection', () => {
    assert.equal(sanitizeRequestId('id\r\nX-Evil: injected'), 'idX-Evil: injected');
  });

  test('strips all ASCII control characters', () => {
    assert.equal(sanitizeRequestId('id\x00\x01\x1F\x7F'), 'id');
  });

  test('returns undefined for empty string', () => {
    assert.equal(sanitizeRequestId(''), undefined);
  });

  test('returns undefined for whitespace-only string', () => {
    assert.equal(sanitizeRequestId('   '), undefined);
  });

  test('returns undefined for undefined input', () => {
    assert.equal(sanitizeRequestId(undefined), undefined);
  });

  test('returns undefined when value exceeds REQUEST_ID_MAX_LENGTH', () => {
    const oversized = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1);
    assert.equal(sanitizeRequestId(oversized), undefined);
  });

  test('accepts value exactly at REQUEST_ID_MAX_LENGTH', () => {
    const maxLen = 'a'.repeat(REQUEST_ID_MAX_LENGTH);
    assert.equal(sanitizeRequestId(maxLen), maxLen);
  });
});

describe('requestId middleware', () => {
  test('uses incoming x-request-id header as request id and response header', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? 'test-id-123' : undefined),
    } as unknown as Request;

    const res = {
      setHeader: (name: string, value: string) => {
        assert.equal(name, 'X-Request-Id');
        assert.equal(value, 'test-id-123');
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as any).id, 'test-id-123');
      assert.equal(getRequestId(), 'test-id-123');
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('generates a UUID request id when header is absent and sets it on response', (done) => {
    const req = {
      header: () => undefined,
    } as unknown as Request;

    let setHeaderValue: string | undefined;

    const res = {
      setHeader: (_name: string, value: string) => {
        setHeaderValue = value;
      },
    } as unknown as Response;

    const next = (() => {
      assert.ok((req as any).id, 'req.id must be set');
      assert.ok(setHeaderValue, 'response X-Request-Id must be set');
      assert.equal((req as any).id, setHeaderValue);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      assert.match((req as any).id, uuidRegex);
      assert.equal(getRequestId(), (req as any).id);

      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('strips whitespace from x-request-id header before using it', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? '  test-trim-id  ' : undefined),
    } as unknown as Request;

    const res = {
      setHeader: (_name: string, value: string) => {
        assert.equal(value, 'test-trim-id');
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as any).id, 'test-trim-id');
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('generates a UUID when header contains only control characters', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? '\r\n\x00' : undefined),
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('generates a UUID when header value exceeds max length', (done) => {
    const oversized = 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1);
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? oversized : undefined),
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      // Must not echo the oversized value back
      assert.notEqual(setHeaderValue, oversized);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('strips CRLF injection attempt and uses sanitized value', (done) => {
    // After stripping control chars the remaining value is non-empty, so it should be used.
    const req = {
      header: (name: string) =>
        name.toLowerCase() === 'x-request-id' ? 'safe-id\r\nX-Evil: injected' : undefined,
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.equal(setHeaderValue, 'safe-idX-Evil: injected');
      assert.ok(!setHeaderValue?.includes('\r'));
      assert.ok(!setHeaderValue?.includes('\n'));
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });
});
