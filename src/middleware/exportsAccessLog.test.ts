import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import {
  createExportsAccessLogMiddleware,
  exportsLogger,
  EXPORTS_LOG_REDACTED_VALUE,
  exportsAccessLogMiddleware,
} from './exportsAccessLog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeReq = EventEmitter &
  Request & {
    headers: Record<string, string | string[]>;
    id?: string;
    params: Record<string, string>;
    body: Record<string, unknown>;
  };

type FakeRes = EventEmitter &
  Response & {
    statusCode: number;
    writableEnded: boolean;
    locals: Record<string, unknown>;
    write: jest.Mock;
    end: jest.Mock;
    setHeader: jest.Mock;
  };

function makeReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return Object.assign(new EventEmitter(), {
    method: 'GET',
    path: '/api/exports/schedules',
    headers: {},
    id: undefined,
    params: {},
    body: {},
    ...overrides,
  }) as FakeReq;
}

function makeRes(overrides: Partial<FakeRes> = {}): FakeRes {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: true,
    locals: {},
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(() => true),
    ...overrides,
  }) as FakeRes;
}

// ---------------------------------------------------------------------------
// createExportsAccessLogMiddleware
// ---------------------------------------------------------------------------

describe('createExportsAccessLogMiddleware', () => {
  test('emits a structured log with all base fields on 2xx', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();

      const req = makeReq({
        method: 'GET',
        path: '/api/exports/schedules',
        headers: { 'x-request-id': 'req-exports-1' },
        id: 'req-exports-1',
      });

      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const payload = infoSpy.mock.calls[0][0];
      expect(payload).toEqual(
        expect.objectContaining({
          correlationId: 'req-exports-1',
          requestId: 'req-exports-1',
          method: 'GET',
          path: '/api/exports/schedules',
          status: 200,
          statusCode: 200,
          ms: expect.any(Number),
          durationMs: expect.any(Number),
          responseBytes: 0,
        }),
      );
      expect(infoSpy.mock.calls[0][1]).toBe('exports request completed');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('includes actor and userId from res.locals.authenticatedUser', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();

      const req = makeReq({
        method: 'GET',
        path: '/api/exports/schedules',
        headers: { 'x-request-id': 'req-actor-1' },
        id: 'req-actor-1',
      });

      const res = makeRes({
        statusCode: 200,
        locals: { authenticatedUser: { id: 'dev-xyz' } },
      });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          userId: 'dev-xyz',
          actor: 'dev-xyz',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('includes scheduleId from req.params when present', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();

      const req = makeReq({
        method: 'PATCH',
        path: '/api/exports/schedules/sched-42',
        headers: { 'x-request-id': 'req-patch-1' },
        id: 'req-patch-1',
        params: { scheduleId: 'sched-42' },
      });

      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ scheduleId: 'sched-42' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('counts responseBytes from res.write and res.end', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-bytes-1' }, id: 'req-bytes-1' });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.write('hello');           // 5 bytes
      res.end(Buffer.from(' world')); // 6 bytes
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ responseBytes: 11 }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs at warn level for 4xx responses', () => {
    const warnSpy = jest.spyOn(exportsLogger, 'warn').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-4xx' }, id: 'req-4xx' });
      const res = makeRes({ statusCode: 404 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 404, statusCode: 404 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('logs at error level for 5xx responses', () => {
    const errorSpy = jest.spyOn(exportsLogger, 'error').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-5xx' }, id: 'req-5xx' });
      const res = makeRes({ statusCode: 500 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 500, statusCode: 500 }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('emits log on close when response is not writableEnded', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-close' }, id: 'req-close' });
      const res = makeRes({ statusCode: 200, writableEnded: false });

      middleware(req, res, jest.fn());
      res.emit('close');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ requestId: 'req-close' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('emits log only once when both finish and close fire', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-once' }, id: 'req-once' });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');
      res.emit('close');

      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('prefers x-correlation-id over x-request-id for correlationId', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({
        headers: {
          'x-request-id': 'req-id-1',
          'x-correlation-id': 'corr-id-1',
        },
        id: 'req-id-1',
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'corr-id-1',
          requestId: 'req-id-1',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('generates a uuid requestId when no id is present', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: {}, id: undefined });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          requestId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('redacts configured fields (case-insensitive)', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware({
        redactFields: ['path', 'userId'],
      });

      const req = makeReq({
        method: 'GET',
        path: '/api/exports/schedules',
        headers: { 'x-request-id': 'req-redact' },
        id: 'req-redact',
      });
      const res = makeRes({
        statusCode: 200,
        locals: { authenticatedUser: { id: 'dev-secret' } },
      });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          path: EXPORTS_LOG_REDACTED_VALUE,
          userId: EXPORTS_LOG_REDACTED_VALUE,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('does not include scheduleId when params is empty', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({
        headers: { 'x-request-id': 'req-no-sched' },
        id: 'req-no-sched',
        params: {},
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).not.toHaveProperty('scheduleId');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('does not include userId / actor when unauthenticated', () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);

    try {
      const middleware = createExportsAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-unauth' }, id: 'req-unauth' });
      const res = makeRes({ statusCode: 200, locals: {} });

      middleware(req, res, jest.fn());
      res.emit('finish');

      const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('userId');
      expect(payload).not.toHaveProperty('actor');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('uses a custom logger when provided', () => {
    const customInfo = jest.fn();
    const customLogger = { info: customInfo, warn: jest.fn(), error: jest.fn() };

    const middleware = createExportsAccessLogMiddleware({ logger: customLogger });
    const req = makeReq({ headers: { 'x-request-id': 'req-custom-log' }, id: 'req-custom-log' });
    const res = makeRes({ statusCode: 200 });

    middleware(req, res, jest.fn());
    res.emit('finish');

    expect(customInfo).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// exportsLogger channel label
// ---------------------------------------------------------------------------

describe('exportsLogger', () => {
  test('has channel=exports', () => {
    expect(exportsLogger).toBeDefined();
    expect(exportsLogger.bindings?.()).toEqual(
      expect.objectContaining({ channel: 'exports' }),
    );
  });
});

// ---------------------------------------------------------------------------
// singleton exportsAccessLogMiddleware
// ---------------------------------------------------------------------------

describe('exportsAccessLogMiddleware', () => {
  test('is a function', () => {
    expect(typeof exportsAccessLogMiddleware).toBe('function');
  });
});
