import type { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';
import { logger } from './logging.js';
import { createMemoryAccountingMiddleware } from './memoryAccounting.js';

describe('createMemoryAccountingMiddleware', () => {
  let warnSpy: jest.SpyInstance;
  let memoryUsageSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    memoryUsageSpy = jest.spyOn(process, 'memoryUsage').mockImplementation(() => ({
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      rss: 150 * 1024 * 1024,
      arrayBuffers: 0,
      external: 0,
    }));
  });

  afterEach(() => {
    warnSpy.mockRestore();
    memoryUsageSpy.mockRestore();
  });

  function makeReq(overrides?: Partial<Request>): Request {
    return {
      id: 'test-req-id',
      method: 'GET',
      path: '/test',
      header: jest.fn(),
      ...overrides,
    } as unknown as Request;
  }

  function makeRes(): Response {
    const res = new EventEmitter() as unknown as Response;
    res.statusCode = 200;
    res.setHeader = jest.fn();
    res.getHeader = jest.fn();
    res.headersSent = false;
    return res;
  }

  describe('when disabled', () => {
    test('calls next immediately without attaching finish listener', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: false, thresholdMb: 50 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      const listenerCountBefore = res.listenerCount('finish');
      middleware(req, res, next);
      const listenerCountAfter = res.listenerCount('finish');

      expect(next).toHaveBeenCalledTimes(1);
      expect(listenerCountAfter).toBe(listenerCountBefore);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('does not sample heap when disabled', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: false, thresholdMb: 50 });
      middleware(makeReq(), makeRes(), jest.fn() as NextFunction);
      expect(memoryUsageSpy).not.toHaveBeenCalled();
    });
  });

  describe('when enabled', () => {
    test('calls next and registers finish listener', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 50 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.listenerCount('finish')).toBe(1);
    });

    test('logs warning when heap delta exceeds threshold', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 10 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 30 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'test-req-id',
          method: 'GET',
          path: '/test',
          heapDeltaBytes: 20 * 1024 * 1024,
          thresholdMb: 10,
        }),
        'memory threshold exceeded'
      );
    });

    test('does not log when heap delta is within threshold', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 50 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 20 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('does not log when heap delta is zero', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 1 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 25 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 25 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('does not log when heap delta is negative (GC reclaimed memory)', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 1 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 30 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('uses fallback requestId when req.id is not set', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 0 });
      const req = makeReq({ id: undefined as unknown as string });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 0, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: undefined,
          heapDeltaBytes: 10 * 1024 * 1024,
        }),
        'memory threshold exceeded'
      );
    });

    test('uses req.id as requestId when set', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 0 });
      const req = makeReq({ id: 'explicit-id' });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 0, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 5 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'explicit-id' }),
        'memory threshold exceeded'
      );
    });

    test('warns with threshold of 0 on any positive delta', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 0 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024 + 1, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('samples heap at start and end of request', () => {
      const middleware = createMemoryAccountingMiddleware({ enabled: true, thresholdMb: 50 });
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      memoryUsageSpy
        .mockReturnValueOnce({ heapUsed: 5 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 })
        .mockReturnValueOnce({ heapUsed: 10 * 1024 * 1024, heapTotal: 50 * 1024 * 1024, rss: 100 * 1024 * 1024, arrayBuffers: 0, external: 0 });

      middleware(req, res, next);
      res.emit('finish');

      expect(memoryUsageSpy).toHaveBeenCalledTimes(2);
    });
  });
});
