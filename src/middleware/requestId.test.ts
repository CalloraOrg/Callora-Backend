import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { getRequestId } from '../logger.js';
import { requestIdMiddleware } from './requestId.js';

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
      // Validate that request context is set for middleware chain.
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

      // Check generated ID character format resembles a UUID v4 string.
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
});
