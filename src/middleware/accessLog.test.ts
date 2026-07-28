import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import { logger } from './logging.js';
import {
  createAccessLogMiddleware,
  ACCESS_LOG_REDACTED_VALUE,
  createHealthAccessLogMiddleware,
} from './accessLog.js';

describe('createAccessLogMiddleware', () => {
  test('logs structured JSON with correlation id and byte counts', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createAccessLogMiddleware({ random: () => 0 });

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/api/vault/deposit/prepare',
        headers: { 'x-request-id': 'req-access-1' },
        id: 'req-access-1',
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
        };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 201,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      req.emit('data', Buffer.from('hello'));
      req.emit('data', Buffer.from(' world'));
      res.write('abc');
      res.end(Buffer.from('def'));
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'req-access-1',
          requestId: 'req-access-1',
          method: 'POST',
          path: '/api/vault/deposit/prepare',
          status: 201,
          statusCode: 201,
          ms: expect.any(Number),
          durationMs: expect.any(Number),
          requestBytes: 11,
          responseBytes: 6,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('redacts configured access-log fields and supports sampling', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createAccessLogMiddleware({
      redactFields: ['path', 'correlationId'],
      sampleRate: 1,
      random: () => 0.99,
    });

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/secret',
        headers: {},
        id: 'req-redacted',
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
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: ACCESS_LOG_REDACTED_VALUE,
          path: ACCESS_LOG_REDACTED_VALUE,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('uses a correlation id from request headers when present', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createAccessLogMiddleware({ random: () => 0 });

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/apis',
        headers: { 'x-correlation-id': 'corr-123' },
        id: undefined,
      }) as unknown as EventEmitter & Request & { id?: string };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'corr-123',
          requestId: expect.any(String),
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('skips logging when sample rate is zero', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createAccessLogMiddleware({ sampleRate: 0, random: () => 0 });

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: {},
        id: 'req-sampled-out',
      }) as unknown as EventEmitter & Request & { id?: string };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('createHealthAccessLogMiddleware', () => {
  test('logs structured JSON with req-id, latency, status, and size', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createHealthAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: { 'x-request-id': 'req-health-1' },
        id: 'req-health-1',
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
        };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.write(Buffer.from('health'));
      res.end(Buffer.from('ok'));
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const logPayload = infoSpy.mock.calls[0][0];
      expect(logPayload).toEqual(
        expect.objectContaining({
          requestId: 'req-health-1',
          latencyMs: expect.any(Number),
          status: 200,
          responseBytes: 8,
        }),
      );
      expect(logPayload).not.toHaveProperty('actor');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs at warn level for 4xx status codes', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const middleware = createHealthAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: {},
        id: 'req-health-4xx',
      }) as unknown as EventEmitter & Request & { id?: string; headers: Record<string, string> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 404,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          status: 404,
          requestId: 'req-health-4xx',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('logs at error level for 5xx status codes', () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const middleware = createHealthAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: {},
        id: 'req-health-5xx',
      }) as unknown as EventEmitter & Request & { id?: string; headers: Record<string, string> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 503,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          status: 503,
          requestId: 'req-health-5xx',
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('sets x-request-id header on response', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createHealthAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: {},
        id: 'req-header-test',
      }) as unknown as EventEmitter & Request & { id?: string; headers: Record<string, string> };

      const setHeaderSpy = jest.fn();
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        setHeader: setHeaderSpy,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(setHeaderSpy).toHaveBeenCalledWith('x-request-id', 'req-header-test');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('generates UUID when no request id is provided', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createHealthAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: {},
      }) as unknown as EventEmitter & Request & { headers: Record<string, string> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const logPayload = infoSpy.mock.calls[0][0] as { requestId: string };
      expect(logPayload.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('uses x-request-id header when available', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createHealthAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/health',
        headers: { 'x-request-id': 'header-request-id' },
      }) as unknown as EventEmitter & Request & { headers: Record<string, string> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        setHeader: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(() => true),
      }) as unknown as EventEmitter &
        Response & {
          statusCode: number;
          write: jest.Mock;
          end: jest.Mock;
          setHeader: jest.Mock;
          writableEnded: boolean;
        };

      middleware(req, res, jest.fn());
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const logPayload = infoSpy.mock.calls[0][0] as { requestId: string };
      expect(logPayload.requestId).toBe('header-request-id');
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('billingAccessLog re-exports from accessLog', () => {
  test('exports createBillingAccessLogMiddleware and billingAccessLogMiddleware', () => {
    const {
      createBillingAccessLogMiddleware,
      billingAccessLogMiddleware,
    } = require('./accessLog.js');
    expect(typeof createBillingAccessLogMiddleware).toBe('function');
    expect(typeof billingAccessLogMiddleware).toBe('function');
  });

  test('re-exported middleware logs structured JSON with req-id, latency, status, size, actor', () => {
    const {
      createBillingAccessLogMiddleware,
      billingLogger,
    } = require('./accessLog.js');
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const middleware = createBillingAccessLogMiddleware();

      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/api/billing/deduct',
        headers: { 'x-request-id': 'reexport-req-1' },
        id: 'reexport-req-1',
        body: { developerId: 'dev-777' },
      }) as unknown as EventEmitter & Request & { id?: string; body: Record<string, unknown> };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: true,
        write: jest.fn(() => true),
        end: jest.fn(() => true),
        setHeader: jest.fn(),
        locals: { authenticatedUser: { id: 'user-777' } },
      }) as unknown as EventEmitter & Response & { statusCode: number; locals: Record<string, unknown> };

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          'req-id': 'reexport-req-1',
          requestId: 'reexport-req-1',
          status: 200,
          latency: expect.any(Number),
          size: expect.any(Number),
          actor: 'user-777',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});

