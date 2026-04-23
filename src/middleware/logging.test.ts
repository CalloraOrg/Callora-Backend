import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import { REDACTED_LOG_VALUE } from '../logger.js';
import { logger, requestLogger, structuredLoggerOptions } from './logging.js';

describe('structured logger options', () => {
  test('redaction hook masks sensitive structured fields before logging', () => {
    const method = jest.fn();

    structuredLoggerOptions.hooks?.logMethod?.call(
      {} as never,
      [
        {
          headers: {
            authorization: 'Bearer top-secret',
            'x-api-key': 'ck_live_secret',
          },
          password: 'super-secret',
          nested: {
            token: 'jwt-secret',
            ok: true,
          },
        },
      ],
      method,
      30,
    );

    expect(method).toHaveBeenCalledWith({
      headers: {
        authorization: REDACTED_LOG_VALUE,
        'x-api-key': REDACTED_LOG_VALUE,
      },
      password: REDACTED_LOG_VALUE,
      nested: {
        token: REDACTED_LOG_VALUE,
        ok: true,
      },
    });
  });
});

describe('requestLogger', () => {
  test('logs only safe request metadata and honors caller request id', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    try {
      const req = {
        headers: {
          authorization: 'Bearer secret-token',
          'x-api-key': 'ck_live_secret',
          'x-request-id': 'req-safe-1',
        },
        method: 'POST',
        path: '/api/vault/deposit/prepare',
      } as unknown as Request;

      const res = new EventEmitter() as EventEmitter &
        Response & {
          statusCode: number;
          setHeader: jest.Mock;
        };
      res.statusCode = 200;
      res.setHeader = jest.fn();

      const next = jest.fn();

      requestLogger(req, res, next);
      res.emit('finish');

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req-safe-1');
      expect(infoSpy).toHaveBeenCalledTimes(1);

      const [payload, message] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect(message).toBe('request completed');
      expect(payload.requestId).toBe('req-safe-1');
      expect(payload.method).toBe('POST');
      expect(payload.path).toBe('/api/vault/deposit/prepare');
      expect(payload.statusCode).toBe(200);
      expect(typeof payload.durationMs).toBe('number');
      expect('headers' in payload).toBe(false);
      expect('body' in payload).toBe(false);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('honors req.id set by upstream middleware', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    try {
      const req = {
        id: 'req-from-id-property',
        headers: {},
        method: 'GET',
        path: '/test',
      } as unknown as Request;

      const res = new EventEmitter() as EventEmitter &
        Response & {
          statusCode: number;
          setHeader: jest.Mock;
        };
      res.statusCode = 200;
      res.setHeader = jest.fn();

      requestLogger(req, res, jest.fn());
      res.emit('finish');

      const [payload] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload.requestId).toBe('req-from-id-property');
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req-from-id-property');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('uses error severity for 5xx responses', () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);

    try {
      const req = {
        headers: {},
        method: 'GET',
        path: '/api/health',
      } as unknown as Request;

      const res = new EventEmitter() as EventEmitter &
        Response & {
          statusCode: number;
          setHeader: jest.Mock;
        };
      res.statusCode = 503;
      res.setHeader = jest.fn();

      requestLogger(req, res, jest.fn());
      res.emit('finish');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [payload, message] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect(message).toBe('request completed');
      expect(payload.statusCode).toBe(503);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
