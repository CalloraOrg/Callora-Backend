import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import {
  createBillingAccessLogMiddleware,
  billingLogger,
  BILLING_LOG_REDACTED_VALUE,
  billingAccessLogMiddleware,
} from './billingAccessLog.js';

describe('createBillingAccessLogMiddleware', () => {
  test('logs billing request with correlation id and billing fields', () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/billing/deduct',
        headers: { 'x-request-id': 'billing-req-1' },
        id: 'billing-req-1',
        body: {
          requestId: 'client-req-1',
          apiId: 'api-123',
          endpointId: 'ep-456',
          apiKeyId: 'ak-789',
          amountUsdc: '1.50',
        },
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
          body: Record<string, unknown>;
        };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        locals: {
          authenticatedUser: { id: 'user-1' },
        },
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'billing-req-1',
          requestId: 'billing-req-1',
          method: 'POST',
          path: '/billing/deduct',
          status: 200,
          statusCode: 200,
          ms: expect.any(Number),
          durationMs: expect.any(Number),
          userId: 'user-1',
          apiId: 'api-123',
          endpointId: 'ep-456',
          apiKeyId: 'ak-789',
          amountUsdc: '1.50',
          billingRequestId: 'client-req-1',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs with warn level for 4xx responses', () => {
    const warnSpy = jest.spyOn(billingLogger, 'warn').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/billing/deduct',
        headers: {},
        id: 'billing-warn',
        body: { amountUsdc: '0' },
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 402,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {},
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 402, statusCode: 402 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('logs with error level for 5xx responses', () => {
    const errorSpy = jest.spyOn(billingLogger, 'error').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/billing/deduct',
        headers: {},
        id: 'billing-error',
        body: {},
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 502,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {},
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 502, statusCode: 502 }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('redacts configured fields', () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware({
        redactFields: ['amountUsdc', 'apiKeyId'],
      });

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/billing/deduct',
        headers: {},
        id: 'billing-redact',
        body: {
          apiKeyId: 'ak-secret',
          amountUsdc: '100.00',
        },
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {},
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          amountUsdc: BILLING_LOG_REDACTED_VALUE,
          apiKeyId: BILLING_LOG_REDACTED_VALUE,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('emits on close if response not writableEnded', () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/billing/request/test-1',
        headers: {},
        id: 'billing-close',
        body: {},
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: false,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {},
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('close');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ method: 'GET', path: '/billing/request/test-1' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('tracks response size in bytes and surfaces actor alongside userId', () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/billing/request/test-1',
        headers: {},
        id: 'billing-size',
        body: {},
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {
          authenticatedUser: { id: 'user-42' },
        },
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());

      const body = JSON.stringify({ success: true, usageEventId: 'evt-1' });
      res.write(Buffer.from('partial-'));
      res.end(body);
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          responseBytes: Buffer.byteLength('partial-') + Buffer.byteLength(body),
          userId: 'user-42',
          actor: 'user-42',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('responseBytes is 0 and actor is absent when nothing is written and no auth user', () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/billing/deduct',
        headers: {},
        id: 'billing-no-body',
        body: {},
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 204,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {},
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.responseBytes).toBe(0);
      expect(payload.actor).toBeUndefined();
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('emits only once on finish + close', () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/billing/deduct',
        headers: {},
        id: 'billing-once',
        body: {},
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: {},
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
          locals: Record<string, unknown>;
        };

      middleware(req, res, jest.fn());
      res.emit('finish');
      res.emit('close');

      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('billingLogger', () => {
  test('has channel=billing', () => {
    expect(billingLogger).toBeDefined();
    expect(billingLogger.bindings?.()).toEqual(
      expect.objectContaining({ channel: 'billing' }),
    );
  });
});

describe('billingAccessLogMiddleware', () => {
  test('is a function', () => {
    expect(typeof billingAccessLogMiddleware).toBe('function');
  });
});
