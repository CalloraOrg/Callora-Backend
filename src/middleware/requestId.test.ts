import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { getRequestId } from '../logger.js';
import {
  requestIdMiddleware,
  responseEnrichMiddleware,
  sanitizeRequestId,
  REQUEST_ID_MAX_LENGTH,
} from './requestId.js';

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
      assert.equal((req as unknown as { id?: string }).id, 'test-id-123');
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
      assert.ok((req as unknown as { id?: string }).id, 'req.id must be set');
      assert.ok(setHeaderValue, 'response X-Request-Id must be set');
      assert.equal((req as unknown as { id?: string }).id, setHeaderValue);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      assert.match((req as unknown as { id?: string }).id ?? '', uuidRegex);
      assert.equal(getRequestId(), (req as unknown as { id?: string }).id);

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
      assert.equal((req as unknown as { id?: string }).id, 'test-trim-id');
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

describe('responseEnrichMiddleware', () => {
  test('injects requestId into a plain-object JSON response body', (done) => {
    const req = { id: 'enrich-req-1' } as unknown as Request;

    let jsonBody: unknown;
    const res = {
      json: function (body: unknown) {
        jsonBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json({ status: 'ok' });
      assert.deepStrictEqual(jsonBody, { status: 'ok', requestId: 'enrich-req-1' });
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('does not overwrite an existing requestId in the body', (done) => {
    const req = { id: 'enrich-req-2' } as unknown as Request;

    let jsonBody: unknown;
    const res = {
      json: function (body: unknown) {
        jsonBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json({ status: 'ok', requestId: 'existing-custom-id' });
      assert.deepStrictEqual(jsonBody, { status: 'ok', requestId: 'existing-custom-id' });
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('does not inject into array responses', (done) => {
    const req = { id: 'enrich-req-3' } as unknown as Request;

    let jsonBody: unknown;
    const res = {
      json: function (body: unknown) {
        jsonBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json([{ name: 'item1' }, { name: 'item2' }]);
      assert.deepStrictEqual(jsonBody, [{ name: 'item1' }, { name: 'item2' }]);
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('does not inject into null responses', (done) => {
    const req = { id: 'enrich-req-4' } as unknown as Request;

    let jsonBody: unknown;
    const res = {
      json: function (body: unknown) {
        jsonBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json(null);
      assert.equal(jsonBody, null);
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('does not inject into primitive responses', (done) => {
    const req = { id: 'enrich-req-5' } as unknown as Request;

    let jsonBody: unknown;
    const res = {
      json: function (body: unknown) {
        jsonBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json('just-a-string');
      assert.equal(jsonBody, 'just-a-string');
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('preserves original res.json return value', (done) => {
    const req = { id: 'enrich-req-6' } as unknown as Request;

    const res = {
      json: function (body: unknown) {
        return { body, _wrapped: true } as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      const result = res.json({ status: 'ok' });
      assert.ok((result as unknown as { _wrapped: boolean })._wrapped);
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('skips injection when req.id is absent and no async context', (done) => {
    const req = {} as unknown as Request;

    let jsonBody: unknown;
    const res = {
      json: function (body: unknown) {
        jsonBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json({ status: 'ok' });
      // When no requestId is available, the body is left untouched
      assert.deepStrictEqual(jsonBody, { status: 'ok' });
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('chains gracefully — res.json still works after multiple calls', (done) => {
    const req = { id: 'enrich-chain' } as unknown as Request;

    const bodies: unknown[] = [];
    const res = {
      json: function (body: unknown) {
        bodies.push(body);
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next = (() => {
      res.json({ first: true });
      res.json({ second: true });
      assert.equal(bodies.length, 2);
      assert.deepStrictEqual(bodies[0], { first: true, requestId: 'enrich-chain' });
      assert.deepStrictEqual(bodies[1], { second: true, requestId: 'enrich-chain' });
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('enriches object bodies sent via res.send()', (done) => {
    const req = { id: 'send-enrich' } as unknown as Request;

    let sendBody: unknown;
    const res = {
      send: function (body: unknown) {
        sendBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response & { send: (body: unknown) => Response };

    const next = (() => {
      res.send({ status: 'ok' });
      assert.deepStrictEqual(sendBody, { status: 'ok', requestId: 'send-enrich' });
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('does not enrich string bodies sent via res.send()', (done) => {
    const req = { id: 'send-string' } as unknown as Request;

    let sendBody: unknown;
    const res = {
      send: function (body: unknown) {
        sendBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response & { send: (body: unknown) => Response };

    const next = (() => {
      res.send('plain-text-response');
      assert.equal(sendBody, 'plain-text-response');
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('does not enrich array bodies sent via res.send()', (done) => {
    const req = { id: 'send-array' } as unknown as Request;

    let sendBody: unknown;
    const res = {
      send: function (body: unknown) {
        sendBody = body;
        return this as unknown as Response;
      },
    } as unknown as Response & { send: (body: unknown) => Response };

    const next = (() => {
      res.send([1, 2, 3]);
      assert.deepStrictEqual(sendBody, [1, 2, 3]);
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });

  test('skips patching when no requestId is available', (done) => {
    const req = {} as unknown as Request;

    // If neither req.id nor ALS context provides a requestId,
    // the original res.json should be left untouched.
    let called = false;
    const originalJson = function (this: unknown, _body: unknown) {
      called = true;
      return this as unknown as Response;
    };
    const res = { json: originalJson } as unknown as Response;

    const next = (() => {
      // res.json should still be the original (unpatched) reference
      assert.equal(res.json, originalJson);
      res.json({ status: 'ok' });
      assert.ok(called);
      done();
    }) as NextFunction;

    responseEnrichMiddleware(req, res, next);
  });
});
