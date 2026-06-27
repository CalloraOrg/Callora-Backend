import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import { logger } from './logging.js';
import { createAccessLogMiddleware, ACCESS_LOG_REDACTED_VALUE } from './accessLog.js';

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
