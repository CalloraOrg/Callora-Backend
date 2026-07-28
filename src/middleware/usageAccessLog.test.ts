import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import { createUsageAccessLogMiddleware, USAGE_LOG_REDACTED_VALUE } from './usageAccessLog.js';

describe('createUsageAccessLogMiddleware', () => {
  test('logs structured JSON with correlation id and usage context', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = createUsageAccessLogMiddleware({ logger: mockLogger });

    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/',
      headers: { 'x-request-id': 'req-usage-1' },
      id: 'req-usage-1',
      query: { apiId: 'api-42', groupBy: 'day', from: '2026-01-01', to: '2026-01-31' },
      header: jest.fn(),
    }) as unknown as EventEmitter &
      Request & {
        headers: Record<string, string>;
        id?: string;
        query: Record<string, string>;
      };

    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: true,
      write: jest.fn(() => true),
      end: jest.fn(() => true),
      locals: { authenticatedUser: { id: 'user-1' } },
    }) as unknown as EventEmitter &
      Response & {
        statusCode: number;
        write: jest.Mock;
        end: jest.Mock;
        writableEnded: boolean;
        locals: Record<string, unknown>;
      };

    middleware(req, res, jest.fn());
    res.end();
    res.emit('finish');

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const payload = mockLogger.info.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        correlationId: 'req-usage-1',
        requestId: 'req-usage-1',
        method: 'GET',
        path: '/',
        status: 200,
        statusCode: 200,
        ms: expect.any(Number),
        durationMs: expect.any(Number),
        requestBytes: 0,
        responseBytes: 0,
        userId: 'user-1',
        apiId: 'api-42',
        groupBy: 'day',
        from: '2026-01-01',
        to: '2026-01-31',
      }),
    );
  });

  test('uses correlation id from x-correlation-id header', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = createUsageAccessLogMiddleware({ logger: mockLogger });

    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/',
      headers: { 'x-correlation-id': 'corr-usage-99' },
      id: undefined,
      query: {},
      header: jest.fn(),
    }) as unknown as EventEmitter &
      Request & {
        headers: Record<string, string>;
        id?: string;
      };

    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: true,
      write: jest.fn(() => true),
      end: jest.fn(() => true),
      locals: {},
    }) as unknown as EventEmitter &
      Response & {
        statusCode: number;
        write: jest.Mock;
        end: jest.Mock;
        writableEnded: boolean;
        locals: Record<string, unknown>;
      };

    middleware(req, res, jest.fn());
    res.end();
    res.emit('finish');

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        correlationId: 'corr-usage-99',
      }),
    );
  });

  test('logs at error level for 5xx status', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = createUsageAccessLogMiddleware({ logger: mockLogger });

    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/',
      headers: {},
      id: 'req-err',
      query: {},
      header: jest.fn(),
    }) as unknown as EventEmitter & Request & { id?: string };

    const res = Object.assign(new EventEmitter(), {
      statusCode: 500,
      writableEnded: true,
      write: jest.fn(() => true),
      end: jest.fn(() => true),
      locals: {},
    }) as unknown as EventEmitter &
      Response & {
        statusCode: number;
        write: jest.Mock;
        end: jest.Mock;
        writableEnded: boolean;
        locals: Record<string, unknown>;
      };

    middleware(req, res, jest.fn());
    res.end();
    res.emit('finish');

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  test('logs at warn level for 4xx status', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = createUsageAccessLogMiddleware({ logger: mockLogger });

    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/',
      headers: {},
      id: 'req-warn',
      query: {},
      header: jest.fn(),
    }) as unknown as EventEmitter & Request & { id?: string };

    const res = Object.assign(new EventEmitter(), {
      statusCode: 401,
      writableEnded: true,
      write: jest.fn(() => true),
      end: jest.fn(() => true),
      locals: {},
    }) as unknown as EventEmitter &
      Response & {
        statusCode: number;
        write: jest.Mock;
        end: jest.Mock;
        writableEnded: boolean;
        locals: Record<string, unknown>;
      };

    middleware(req, res, jest.fn());
    res.end();
    res.emit('finish');

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  test('redacts configured fields', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = createUsageAccessLogMiddleware({
      logger: mockLogger,
      redactFields: ['userId', 'path'],
    });

    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/secret',
      headers: {},
      id: 'req-redact',
      query: {},
      header: jest.fn(),
    }) as unknown as EventEmitter & Request & { id?: string };

    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: true,
      write: jest.fn(() => true),
      end: jest.fn(() => true),
      locals: { authenticatedUser: { id: 'user-secret' } },
    }) as unknown as EventEmitter &
      Response & {
        statusCode: number;
        write: jest.Mock;
        end: jest.Mock;
        writableEnded: boolean;
        locals: Record<string, unknown>;
      };

    middleware(req, res, jest.fn());
    res.end();
    res.emit('finish');

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const payload = mockLogger.info.mock.calls[0][0];
    expect(payload.userId).toBe(USAGE_LOG_REDACTED_VALUE);
    expect(payload.path).toBe(USAGE_LOG_REDACTED_VALUE);
  });
});
