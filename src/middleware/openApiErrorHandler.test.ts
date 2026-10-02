import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import {
  openApiErrorHandler,
  formatOpenApiField,
  formatOpenApiCode,
} from './openApiErrorHandler.js';

function response() {
  const result = { statusCode: 200, body: undefined as unknown, sent: false };
  const value = {
    headersSent: false,
    status(code: number) {
      result.statusCode = code;
      return value;
    },
    json(body: unknown) {
      result.body = body;
      result.sent = true;
      return value;
    },
  } as unknown as Response;
  return { result, value };
}

function request(id = 'req-openapi-123'): Request {
  return { id } as Request;
}

function body(result: { body: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe('openApiErrorHandler', () => {
  describe('formatOpenApiField', () => {
    it('formats query parameters properly', () => {
      expect(formatOpenApiField({ path: '/query/limit' }, 0)).toBe('query.limit');
      expect(formatOpenApiField({ path: '.query.limit' }, 0)).toBe('query.limit');
      expect(formatOpenApiField({ path: 'request.query.limit' }, 0)).toBe('query.limit');
    });

    it('formats missing query parameter with missingProperty', () => {
      expect(
        formatOpenApiField(
          { path: '/query', params: { missingProperty: 'limit' } },
          0,
        ),
      ).toBe('query.limit');
    });

    it('formats body fields and nested arrays', () => {
      expect(formatOpenApiField({ path: '/body/name' }, 0)).toBe('body.name');
      expect(formatOpenApiField({ path: '/body/endpoints/0/path' }, 0)).toBe(
        'body.endpoints[0].path',
      );
      expect(
        formatOpenApiField({ path: '/body/items/1/tags/2/name' }, 0),
      ).toBe('body.items[1].tags[2].name');
    });

    it('formats path params and headers', () => {
      expect(formatOpenApiField({ path: '/params/id' }, 0)).toBe('params.id');
      expect(formatOpenApiField({ path: '/headers/x-api-key' }, 0)).toBe(
        'headers.x-api-key',
      );
    });

    it('handles fallback and location prefixes', () => {
      expect(formatOpenApiField({ path: '/limit', location: 'query' }, 0)).toBe(
        'query.limit',
      );
      expect(formatOpenApiField({ location: 'query' }, 0)).toBe('query');
      expect(formatOpenApiField({}, 0)).toBe('body');
      expect(formatOpenApiField('invalid', 2)).toBe('body.2');
    });
  });

  describe('formatOpenApiCode', () => {
    it('extracts code from code, keyword, or errorCode', () => {
      expect(formatOpenApiCode({ code: 'INVALID_FORMAT' }, 'body.email')).toBe(
        'INVALID_FORMAT',
      );
      expect(formatOpenApiCode({ keyword: 'required' }, 'query.limit')).toBe(
        'REQUIRED',
      );
      expect(
        formatOpenApiCode(
          { errorCode: 'required.openapi.validation' },
          'query.limit',
        ),
      ).toBe('REQUIRED');
      expect(
        formatOpenApiCode({ errorCode: 'type.openapi.validation' }, 'body.age'),
      ).toBe('TYPE');
    });

    it('falls back based on field location', () => {
      expect(formatOpenApiCode({}, 'query.limit')).toBe('INVALID_QUERY');
      expect(formatOpenApiCode({}, 'params.id')).toBe('INVALID_PARAMS');
      expect(formatOpenApiCode({}, 'body.name')).toBe('INVALID_BODY');
    });
  });

  describe('middleware behavior', () => {
    it('passes through errors without status to next()', () => {
      const output = response();
      const next = jest.fn() as unknown as NextFunction;
      const error = new Error('database connection failed');

      openApiErrorHandler(error, request(), output.value, next);

      expect(next).toHaveBeenCalledWith(error);
      expect(output.result.sent).toBe(false);
    });

    it('handles 400 validation errors with detailed fields', () => {
      const output = response();
      const next = jest.fn() as unknown as NextFunction;
      const error = Object.assign(
        new Error("request.query should have required property 'limit'"),
        {
          status: 400,
          errors: [
            {
              path: '/query/limit',
              message: "must have required property 'limit'",
              errorCode: 'required.openapi.validation',
            },
          ],
        },
      );

      openApiErrorHandler(error, request('req-400'), output.value, next);

      expect(output.result.statusCode).toBe(400);
      expect(body(output.result)).toEqual({
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: "request.query should have required property 'limit'",
          details: [
            {
              field: 'query.limit',
              message: "must have required property 'limit'",
              code: 'REQUIRED',
            },
          ],
        },
        requestId: 'req-400',
        timestamp: expect.any(String),
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('maps 415 to UNSUPPORTED_MEDIA_TYPE', () => {
      const output = response();
      const next = jest.fn() as unknown as NextFunction;
      const error = Object.assign(
        new Error('unsupported media type "application/xml"'),
        { status: 415 },
      );

      openApiErrorHandler(error, request('req-415'), output.value, next);

      expect(output.result.statusCode).toBe(415);
      expect(body(output.result)).toEqual({
        success: false,
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'unsupported media type "application/xml"',
        },
        requestId: 'req-415',
        timestamp: expect.any(String),
      });
    });

    it('maps 404 to NOT_FOUND', () => {
      const output = response();
      const next = jest.fn() as unknown as NextFunction;
      const error = Object.assign(new Error('not found'), { status: 404 });

      openApiErrorHandler(error, request('req-404'), output.value, next);

      expect(output.result.statusCode).toBe(404);
      expect(body(output.result).error).toEqual({
        code: 'NOT_FOUND',
        message: 'not found',
      });
    });
  });
});
