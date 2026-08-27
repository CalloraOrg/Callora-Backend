import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { AppError, BadRequestError, ConflictError, TooManyRequestsError } from '../errors/index.js';
import { ValidationError } from './validate.js';
import { errorHandler } from './errorHandler.js';

function response() {
  const result = { statusCode: 200, body: undefined as unknown, sent: false };
  const value = {
    headersSent: false,
    status(code: number) { result.statusCode = code; return value; },
    json(body: unknown) { result.body = body; result.sent = true; return value; },
  } as unknown as Response;
  return { result, value };
}

function request(id = 'req-123'): Request {
  return { id } as Request;
}

function body(result: { body: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe('errorHandler contract', () => {
  it('maps a trusted bad request to the versioned envelope', () => {
    const output = response();
    errorHandler(new BadRequestError('amount is invalid'), request(), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(400);
    expect(body(output.result)).toEqual(expect.objectContaining({
      success: false,
      requestId: 'req-123',
      error: { code: 'BAD_REQUEST', message: 'amount is invalid' },
    }));
    expect(body(output.result)).toHaveProperty('timestamp');
  });

  it('preserves a stable domain-specific public code', () => {
    const output = response();
    errorHandler(new AppError('wallet blocked', 403, 'API_ACCESS_FORBIDDEN'), request('domain-id'), output.value, jest.fn() as unknown as NextFunction);
    expect(body(output.result).error).toEqual({ code: 'API_ACCESS_FORBIDDEN', message: 'wallet blocked' });
    expect(body(output.result).requestId).toBe('domain-id');
  });

  it('maps conflict and rate-limit errors to their public codes', () => {
    const conflict = response();
    errorHandler(new ConflictError('duplicate request'), request(), conflict.value, jest.fn() as unknown as NextFunction);
    expect((body(conflict.result).error as Record<string, unknown>).code).toBe('CONFLICT');
    const limited = response();
    errorHandler(new TooManyRequestsError('slow down'), request(), limited.value, jest.fn() as unknown as NextFunction);
    expect(limited.result.statusCode).toBe(429);
    expect((body(limited.result).error as Record<string, unknown>).code).toBe('TOO_MANY_REQUESTS');
  });

  it('returns field-level validation details without a stack', () => {
    const output = response();
    const error = new ValidationError([
      { field: 'body.email', message: 'must be an email', code: 'INVALID_FORMAT' },
      { field: 'body.amount', message: 'required', code: 'REQUIRED' },
    ]);
    errorHandler(error, request('validation-id'), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(400);
    expect(body(output.result)).toEqual(expect.objectContaining({ success: false, requestId: 'validation-id' }));
    expect((body(output.result).error as Record<string, unknown>).details).toEqual([
      { field: 'body.email', message: 'must be an email', code: 'INVALID_FORMAT' },
      { field: 'body.amount', message: 'required', code: 'REQUIRED' },
    ]);
    expect(JSON.stringify(output.result.body)).not.toContain('stack');
  });

  it('uses a generic message for unknown production failures', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const output = response();
      errorHandler(new Error('postgres password=secret'), request('prod-id'), output.value, jest.fn() as unknown as NextFunction);
      expect(output.result.statusCode).toBe(500);
      expect((body(output.result).error as Record<string, unknown>).message).toBe('Internal server error');
      expect(JSON.stringify(output.result.body)).not.toContain('postgres');
      expect(JSON.stringify(output.result.body)).not.toContain('secret');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('allows safe client diagnostics in development but never server failures', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const client = response();
      const clientError = Object.assign(new Error('invalid cursor format'), { status: 400 });
      errorHandler(clientError, request(), client.value, jest.fn() as unknown as NextFunction);
      expect((body(client.result).error as Record<string, unknown>).message).toBe('invalid cursor format');
      const server = response();
      errorHandler(new Error('service crashed'), request(), server.value, jest.fn() as unknown as NextFunction);
      expect((body(server.result).error as Record<string, unknown>).message).toBe('Internal server error');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('derives a public fallback code for an unknown status', () => {
    const output = response();
    const error = new Error('client failure') as Error & { status: number };
    error.status = 418;
    errorHandler(error, request(), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(418);
    expect((body(output.result).error as Record<string, unknown>).code).toBe('BAD_REQUEST');
  });

  it('does not overwrite a response that already sent headers', () => {
    const output = response();
    (output.value as Response).headersSent = true;
    errorHandler(new Error('already handled'), request(), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.sent).toBe(false);
  });

  it('keeps error responses JSON-compatible for null and non-Error throws', () => {
    for (const thrown of [null, 'failure', 42, { reason: 'failure' }]) {
      const output = response();
      errorHandler(thrown, request('coercion-id'), output.value, jest.fn() as unknown as NextFunction);
      expect(output.result.statusCode).toBe(500);
      expect(body(output.result)).toEqual(expect.objectContaining({ success: false, requestId: 'coercion-id' }));
    }
  });

  it('handles status-bearing upstream errors without echoing their message', () => {
    const output = response();
    const upstream = Object.assign(new Error('upstream api-key leaked'), { status: 502 });
    errorHandler(upstream, request('upstream-id'), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(502);
    expect(body(output.result).error).toEqual({ code: 'BAD_GATEWAY', message: 'Internal server error' });
  });

  it('keeps the request id stable across every error class', () => {
    for (const error of [new BadRequestError(), new ConflictError(), new TooManyRequestsError()]) {
      const output = response();
      errorHandler(error, request('stable-correlation'), output.value, jest.fn() as unknown as NextFunction);
      expect(body(output.result).requestId).toBe('stable-correlation');
    }
  });
});
