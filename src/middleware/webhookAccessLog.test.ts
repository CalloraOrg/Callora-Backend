/**
 * Tests for Webhook Access Log Middleware
 *
 * Covers:
 *   - Structured JSON logging with actor (developerId)
 *   - Request/response byte counting
 *   - Status-based log levels
 */

import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { logger } from './logging.js';
import { createWebhookAccessLogMiddleware } from './webhookAccessLog.js';

describe('createWebhookAccessLogMiddleware', () => {
  test('logs structured JSON with actor from route params', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createWebhookAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/api/webhooks/deliver/dev-123',
        headers: { 'x-request-id': 'req-webhook-1' },
        id: 'req-webhook-1',
        params: { developerId: 'dev-123' },
        body: {},
        header: (name: string) => undefined,
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
          params: Record<string, string>;
          body: Record<string, unknown>;
          header: (name: string) => string | undefined;
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
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const logPayload = infoSpy.mock.calls[0][0];
      expect(logPayload).toEqual(
        expect.objectContaining({
          correlationId: 'req-webhook-1',
          requestId: 'req-webhook-1',
          method: 'POST',
          path: '/api/webhooks/deliver/dev-123',
          status: 200,
          statusCode: 200,
          ms: expect.any(Number),
          durationMs: expect.any(Number),
          requestBytes: expect.any(Number),
          responseBytes: expect.any(Number),
          actor: 'dev-123',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('extracts actor from body when params are not available', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createWebhookAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/api/webhooks',
        headers: {},
        id: 'req-webhook-2',
        params: {},
        body: { developerId: 'dev-456', url: 'https://hook.example.com', events: ['new_api_call'] },
        header: (name: string) => undefined,
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
          params: Record<string, string>;
          body: Record<string, unknown>;
          header: (name: string) => string | undefined;
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
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          actor: 'dev-456',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('omits actor when no developerId is available', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const middleware = createWebhookAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        path: '/api/webhooks/health',
        headers: {},
        id: 'req-webhook-3',
        params: {},
        body: {},
        header: (name: string) => undefined,
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
          params: Record<string, string>;
          body: Record<string, unknown>;
          header: (name: string) => string | undefined;
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
      res.end();
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).not.toHaveProperty('actor');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs at warn level for 4xx status codes', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const middleware = createWebhookAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'DELETE',
        path: '/api/webhooks/dev-789',
        headers: {},
        id: 'req-webhook-4',
        params: { developerId: 'dev-789' },
        body: {},
        header: (name: string) => undefined,
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
          params: Record<string, string>;
          body: Record<string, unknown>;
          header: (name: string) => string | undefined;
        };

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
        expect.objectContaining({ actor: 'dev-789', status: 404 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('logs at error level for 5xx status codes', () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const middleware = createWebhookAccessLogMiddleware();

    try {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        path: '/api/webhooks/deliver/dev-999',
        headers: {},
        id: 'req-webhook-5',
        params: { developerId: 'dev-999' },
        body: {},
        header: (name: string) => undefined,
      }) as unknown as EventEmitter &
        Request & {
          headers: Record<string, string>;
          id?: string;
          params: Record<string, string>;
          body: Record<string, unknown>;
          header: (name: string) => string | undefined;
        };

      const res = Object.assign(new EventEmitter(), {
        statusCode: 500,
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
        expect.objectContaining({ actor: 'dev-999', status: 500 }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
