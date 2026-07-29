import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import {
  createForecastAccessLogMiddleware,
  forecastLogger,
  FORECAST_LOG_REDACTED_VALUE,
  forecastAccessLogMiddleware,
} from './forecastAccessLog.js';

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
    path: '/api/forecast',
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
// createForecastAccessLogMiddleware — core payload
// ---------------------------------------------------------------------------

describe('createForecastAccessLogMiddleware', () => {
  test('emits a structured log with all base fields on 2xx', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();

      const req = makeReq({
        method: 'GET',
        path: '/api/forecast',
        headers: { 'x-request-id': 'req-fc-1' },
        id: 'req-fc-1',
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const [payload, msg] = infoSpy.mock.calls[0];
      expect(payload).toEqual(
        expect.objectContaining({
          correlationId: 'req-fc-1',
          requestId: 'req-fc-1',
          method: 'GET',
          path: '/api/forecast',
          status: 200,
          statusCode: 200,
          ms: expect.any(Number),
          durationMs: expect.any(Number),
          responseBytes: 0,
        }),
      );
      expect(msg).toBe('forecast request completed');
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Actor / userId
  // ---------------------------------------------------------------------------

  test('includes userId and actor from res.locals.authenticatedUser', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();

      const req = makeReq({
        headers: { 'x-request-id': 'req-actor-1' },
        id: 'req-actor-1',
      });
      const res = makeRes({
        statusCode: 200,
        locals: { authenticatedUser: { id: 'dev-xyz' } },
      });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ userId: 'dev-xyz', actor: 'dev-xyz' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('omits userId and actor when unauthenticated', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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

  // ---------------------------------------------------------------------------
  // forecastId route param
  // ---------------------------------------------------------------------------

  test('includes forecastId from req.params.id when present', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();

      const req = makeReq({
        method: 'GET',
        path: '/api/forecast/forecast_abc',
        headers: { 'x-request-id': 'req-fc-id-1' },
        id: 'req-fc-id-1',
        params: { id: 'forecast_abc' },
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ forecastId: 'forecast_abc' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('omits forecastId when params.id is absent', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({
        headers: { 'x-request-id': 'req-no-id' },
        id: 'req-no-id',
        params: {},
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).not.toHaveProperty('forecastId');
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Response size tracking
  // ---------------------------------------------------------------------------

  test('counts responseBytes from res.write and res.end', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-bytes' }, id: 'req-bytes' });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.write('hello');              // 5 bytes
      res.end(Buffer.from(' world'));  // 6 bytes
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ responseBytes: 11 }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Log levels
  // ---------------------------------------------------------------------------

  test('logs at warn level for 4xx responses', () => {
    const warnSpy = jest.spyOn(forecastLogger, 'warn').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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
    const errorSpy = jest.spyOn(forecastLogger, 'error').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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

  test('logs at info level for 201 responses', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-201' }, id: 'req-201' });
      const res = makeRes({ statusCode: 201 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 201 }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs at info level for 204 responses', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-204' }, id: 'req-204' });
      const res = makeRes({ statusCode: 204 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 204 }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs at warn level for 401 responses', () => {
    const warnSpy = jest.spyOn(forecastLogger, 'warn').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-401' }, id: 'req-401' });
      const res = makeRes({ statusCode: 401 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 401, statusCode: 401 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Emit deduplication
  // ---------------------------------------------------------------------------

  test('emits log on close when response is not writableEnded', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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

  test('does not emit a second log when close fires after finish on a writableEnded response', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-ws-end' }, id: 'req-ws-end' });
      const res = makeRes({ statusCode: 200, writableEnded: true });

      middleware(req, res, jest.fn());
      res.emit('finish');
      res.emit('close');

      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Correlation ID resolution
  // ---------------------------------------------------------------------------

  test('prefers x-correlation-id over x-request-id for correlationId', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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

  test('falls back to x-request-id for both correlationId and requestId when no x-correlation-id', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({
        headers: { 'x-request-id': 'req-fallback' },
        id: 'req-fallback',
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'req-fallback',
          requestId: 'req-fallback',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('generates a UUID requestId when no id is present and no headers', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
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

  test('accepts array-valued x-request-id header and uses the first element', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({
        headers: { 'x-request-id': ['arr-id-1', 'arr-id-2'] },
        id: undefined,
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ requestId: 'arr-id-1' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Redaction
  // ---------------------------------------------------------------------------

  test('redacts configured fields (case-insensitive)', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware({
        redactFields: ['path', 'userId'],
      });

      const req = makeReq({
        method: 'GET',
        path: '/api/forecast',
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
          path: FORECAST_LOG_REDACTED_VALUE,
          userId: FORECAST_LOG_REDACTED_VALUE,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('redacts fields regardless of key case in options', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware({
        redactFields: ['PATH', 'CORRELATIONID'],
      });
      const req = makeReq({
        headers: { 'x-request-id': 'req-case' },
        id: 'req-case',
      });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.path).toBe(FORECAST_LOG_REDACTED_VALUE);
      expect(payload.correlationId).toBe(FORECAST_LOG_REDACTED_VALUE);
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Custom logger injection
  // ---------------------------------------------------------------------------

  test('uses a custom logger when provided', () => {
    const customInfo = jest.fn();
    const customLogger = { info: customInfo, warn: jest.fn(), error: jest.fn() };

    const middleware = createForecastAccessLogMiddleware({ logger: customLogger });
    const req = makeReq({ headers: { 'x-request-id': 'req-custom' }, id: 'req-custom' });
    const res = makeRes({ statusCode: 200 });

    middleware(req, res, jest.fn());
    res.emit('finish');

    expect(customInfo).toHaveBeenCalledTimes(1);
  });

  test('custom logger receives warn for 4xx with correct payload', () => {
    const customWarn = jest.fn();
    const customLogger = { info: jest.fn(), warn: customWarn, error: jest.fn() };

    const middleware = createForecastAccessLogMiddleware({ logger: customLogger });
    const req = makeReq({ headers: { 'x-request-id': 'req-custom-4xx' }, id: 'req-custom-4xx' });
    const res = makeRes({ statusCode: 400 });

    middleware(req, res, jest.fn());
    res.emit('finish');

    expect(customWarn).toHaveBeenCalledTimes(1);
    expect(customWarn.mock.calls[0][0]).toEqual(
      expect.objectContaining({ status: 400, requestId: 'req-custom-4xx' }),
    );
  });

  // ---------------------------------------------------------------------------
  // next() is called
  // ---------------------------------------------------------------------------

  test('calls next() immediately', () => {
    const next = jest.fn();
    const middleware = createForecastAccessLogMiddleware();
    const req = makeReq({ headers: {}, id: 'req-next' });
    const res = makeRes({ statusCode: 200 });

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // ms / durationMs are non-negative numbers
  // ---------------------------------------------------------------------------

  test('reports non-negative latency values', () => {
    const infoSpy = jest.spyOn(forecastLogger, 'info').mockImplementation(() => forecastLogger);

    try {
      const middleware = createForecastAccessLogMiddleware();
      const req = makeReq({ headers: { 'x-request-id': 'req-latency' }, id: 'req-latency' });
      const res = makeRes({ statusCode: 200 });

      middleware(req, res, jest.fn());
      res.emit('finish');

      const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof payload.ms).toBe('number');
      expect(payload.ms as number).toBeGreaterThanOrEqual(0);
      expect(payload.durationMs).toBe(payload.ms);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// forecastLogger channel label
// ---------------------------------------------------------------------------

describe('forecastLogger', () => {
  test('has channel=forecast', () => {
    expect(forecastLogger).toBeDefined();
    expect(forecastLogger.bindings?.()).toEqual(
      expect.objectContaining({ channel: 'forecast' }),
    );
  });
});

// ---------------------------------------------------------------------------
// singleton forecastAccessLogMiddleware
// ---------------------------------------------------------------------------

describe('forecastAccessLogMiddleware', () => {
  test('is a function', () => {
    expect(typeof forecastAccessLogMiddleware).toBe('function');
  });
});
