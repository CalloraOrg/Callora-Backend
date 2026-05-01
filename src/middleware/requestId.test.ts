import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { getRequestId } from '../logger.js';
import { requestIdMiddleware, sanitizeRequestId, REQUEST_ID_MAX_LENGTH } from './requestId.js';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('sanitizeRequestId', () => {
  test('returns the value unchanged for a valid UUID', () => {
    assert.equal(sanitizeRequestId(VALID_UUID), VALID_UUID);
  });

  test('trims surrounding whitespace and accepts valid UUID', () => {
    assert.equal(sanitizeRequestId(`  ${VALID_UUID}  `), VALID_UUID);
  });

  test('returns undefined for non-UUID string', () => {
    assert.equal(sanitizeRequestId('trace-abc-123'), undefined);
  });

  test('returns undefined for UUID with injected malicious characters', () => {
    assert.equal(sanitizeRequestId(`${VALID_UUID}\r\nX-Evil: injected`), undefined);
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
    const oversized = VALID_UUID + 'a';
    assert.equal(sanitizeRequestId(oversized), undefined);
  });
});

describe('requestId middleware', () => {
  test('uses incoming x-request-id header if it is a valid UUID', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? VALID_UUID : undefined),
    } as unknown as Request;

    const res = {
      setHeader: (name: string, value: string) => {
        assert.equal(name, 'X-Request-Id');
        assert.equal(value, VALID_UUID);
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as any).id, VALID_UUID);
      assert.equal(getRequestId(), VALID_UUID);
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('generates a new UUID request id when header is absent', (done) => {
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

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      assert.match((req as any).id, uuidRegex);
      assert.equal(getRequestId(), (req as any).id);

      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('generates a new UUID when header is not a valid UUID (e.g. contains PII)', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? 'john.doe@example.com' : undefined),
    } as unknown as Request;

    let setHeaderValue: string | undefined;

    const res = {
      setHeader: (_name: string, value: string) => {
        setHeaderValue = value;
      },
    } as unknown as Response;

    const next = (() => {
      assert.notEqual(setHeaderValue, 'john.doe@example.com');
      assert.notEqual((req as any).id, 'john.doe@example.com');

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      assert.match((req as any).id, uuidRegex);
      
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });

  test('strips whitespace from valid UUID before using it', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-request-id' ? `  ${VALID_UUID}  ` : undefined),
    } as unknown as Request;

    const res = {
      setHeader: (_name: string, value: string) => {
        assert.equal(value, VALID_UUID);
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as any).id, VALID_UUID);
      done();
    }) as NextFunction;

    requestIdMiddleware(req, res, next);
  });
});
