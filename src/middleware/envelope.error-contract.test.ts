import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createResponseValidatorMiddleware,
  envelopeMiddleware,
  errorEnvelopeSchema,
  successEnvelopeSchema,
} from './envelope.js';

interface FakeResult {
  body: unknown;
  statusCode: number;
  contentType?: string;
  sent: boolean;
}

function response(statusCode = 200, contentType?: string) {
  const result: FakeResult = { body: undefined, statusCode, contentType, sent: false };
  const value = {
    headersSent: false,
    statusCode,
    getHeader(name: string) {
      return name.toLowerCase() === 'content-type' ? result.contentType : undefined;
    },
    status(code: number) {
      result.statusCode = code;
      value.statusCode = code;
      return value;
    },
    json(body: unknown) {
      result.body = body;
      result.sent = true;
      return value;
    },
    send(body: unknown) {
      result.body = body;
      result.sent = true;
      return value;
    },
  } as unknown as Response;
  return { result, value };
}

function request(id = 'envelope-test-id'): Request {
  return { id, path: '/contract-test' } as Request;
}

function runMiddleware(middleware: (req: Request, res: Response, next: NextFunction) => void, res: Response) {
  const next = jest.fn() as unknown as NextFunction;
  middleware(request(), res, next);
  expect(next).toHaveBeenCalledTimes(1);
}

describe('envelope middleware error contract', () => {
  it('wraps a plain JSON client error and preserves supported diagnostics', () => {
    const output = response(422);
    runMiddleware(envelopeMiddleware, output.value);

    output.value.json({
      code: 'INVALID_BODY',
      message: 'amount must be positive',
      details: [{ field: 'amount', message: 'must be positive', code: 'MINIMUM' }],
      retryAfterMs: 1500,
    });

    expect(output.result.statusCode).toBe(422);
    expect(errorEnvelopeSchema.parse(output.result.body)).toEqual(expect.objectContaining({
      success: false,
      requestId: 'envelope-test-id',
      error: {
        code: 'INVALID_BODY',
        message: 'amount must be positive',
        details: [{ field: 'amount', message: 'must be positive', code: 'MINIMUM' }],
        retryAfterMs: 1500,
      },
    }));
  });

  it('uses the internal error code when a bare server error is sent', () => {
    const output = response(500);
    runMiddleware(envelopeMiddleware, output.value);
    output.value.json({ message: 'unexpected failure' });

    expect(errorEnvelopeSchema.parse(output.result.body).error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'unexpected failure',
    });
  });

  it('uses the generic client code when an error body has no code', () => {
    const output = response(400);
    runMiddleware(envelopeMiddleware, output.value);
    output.value.json({ error: 'invalid filter' });

    expect(errorEnvelopeSchema.parse(output.result.body).error).toEqual({
      code: 'BAD_REQUEST',
      message: 'invalid filter',
    });
  });

  it('does not double-wrap an error envelope from errorHandler', () => {
    const output = response(409);
    runMiddleware(envelopeMiddleware, output.value);
    const existing = {
      success: false as const,
      error: { code: 'CONFLICT', message: 'already exists' },
      requestId: 'handler-id',
      timestamp: new Date().toISOString(),
    };
    output.value.json(existing);

    expect(output.result.body).toBe(existing);
  });

  it('wraps ordinary successful JSON data with the request metadata', () => {
    const output = response();
    runMiddleware(envelopeMiddleware, output.value);
    output.value.json({ accountId: 'acct-1', active: true });

    const envelope = successEnvelopeSchema.parse(output.result.body);
    expect(envelope).toEqual(expect.objectContaining({
      success: true,
      data: { accountId: 'acct-1', active: true },
      requestId: 'envelope-test-id',
    }));
  });

  it('wraps JSON strings sent by legacy route handlers', () => {
    const output = response();
    runMiddleware(envelopeMiddleware, output.value);
    output.value.send(JSON.stringify({ ok: true }));

    expect(successEnvelopeSchema.parse(JSON.parse(output.result.body as string)).data).toEqual({ ok: true });
  });

  it('leaves non-JSON and streamed content untouched', () => {
    const csv = response(200, 'text/csv; charset=utf-8');
    runMiddleware(envelopeMiddleware, csv.value);
    csv.value.send('id,name\n1,Callora');
    expect(csv.result.body).toBe('id,name\n1,Callora');

    const stream = response(200, 'text/event-stream');
    runMiddleware(envelopeMiddleware, stream.value);
    stream.value.send('data: ping\n\n');
    expect(stream.result.body).toBe('data: ping\n\n');
  });
});

describe('response envelope validator contract', () => {
  it('accepts a fully formed error envelope without changing it', () => {
    const output = response(429);
    runMiddleware(createResponseValidatorMiddleware(), output.value);
    const envelope = {
      success: false as const,
      error: { code: 'TOO_MANY_REQUESTS', message: 'slow down', retryAfterMs: 2000 },
      requestId: 'validator-id',
      timestamp: new Date().toISOString(),
    };
    output.value.json(envelope);

    expect(output.result.body).toBe(envelope);
    expect(output.result.statusCode).toBe(429);
  });

  it('turns an invalid envelope into a safe server error envelope', () => {
    const output = response(200);
    runMiddleware(createResponseValidatorMiddleware(), output.value);
    output.value.json({ success: true, data: { missing: 'metadata' } });

    expect(output.result.statusCode).toBe(500);
    expect(errorEnvelopeSchema.parse(output.result.body).error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Response contract violation: envelope validation failed',
    });
  });

  it('validates endpoint data schemas inside the success envelope', () => {
    const output = response();
    runMiddleware(
      createResponseValidatorMiddleware(z.object({ id: z.string() })),
      output.value,
    );
    output.value.json({
      success: true,
      data: { id: 42 },
      requestId: 'validator-id',
      timestamp: new Date().toISOString(),
    });

    expect(output.result.statusCode).toBe(500);
    expect(errorEnvelopeSchema.parse(output.result.body).error.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
