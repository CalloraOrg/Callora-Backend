import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import { logger } from '../logger.js';
import { resetAllMetrics } from '../metrics.js';
import {
  initSloRecorder,
  resetSloRecorder,
  sloRecorderMiddleware,
  getSloWindow,
  getAllSloWindows,
  getSloConfigs,
} from './sloAlertRecorder.js';
import { sloConfigKey, type SloRouteConfig } from '../services/sloService.js';

function buildReqRes(opts: {
  method?: string;
  path?: string;
  baseUrl?: string;
  routePath?: string | null;
  statusCode?: number;
}): { req: Request; res: Response } {
  const {
    method = 'GET',
    path = '/api/health',
    baseUrl = '',
    routePath = path,
    statusCode = 200,
  } = opts;

  const req = {
    method,
    path,
    baseUrl,
    route: routePath !== null ? { path: routePath } : undefined,
  } as unknown as Request;

  const res = Object.assign(new EventEmitter(), {
    statusCode,
  }) as unknown as Response;

  return { req, res };
}

describe('sloAlertRecorder', () => {
  beforeEach(() => {
    resetSloRecorder();
  });

  afterEach(() => {
    resetSloRecorder();
    resetAllMetrics();
  });

  describe('initSloRecorder', () => {
    it('throws on non-positive observationWindowMs', () => {
      expect(() =>
        initSloRecorder({ configs: [], observationWindowMs: 0 }),
      ).toThrow('observationWindowMs must be a positive number');
      expect(() =>
        initSloRecorder({ configs: [], observationWindowMs: -1 }),
      ).toThrow('observationWindowMs must be a positive number');
      expect(() =>
        initSloRecorder({ configs: [], observationWindowMs: Number.NaN }),
      ).toThrow('observationWindowMs must be a positive number');
    });

    it('throws when configs is not an array', () => {
      expect(() =>
        initSloRecorder({
          configs: null as unknown as readonly SloRouteConfig[],
          observationWindowMs: 600_000,
        }),
      ).toThrow('configs must be an array');
    });

    it('throws when a config has invalid method or route', () => {
      expect(() =>
        initSloRecorder({
          configs: [
            { method: '', route: '/api/foo' } as SloRouteConfig,
          ],
          observationWindowMs: 600_000,
        }),
      ).toThrow('method and route must be non-empty');

      expect(() =>
        initSloRecorder({
          configs: [
            { method: 'GET', route: '' } as SloRouteConfig,
          ],
          observationWindowMs: 600_000,
        }),
      ).toThrow('method and route must be non-empty');
    });

    it('registers one window per unique (method, route) config', () => {
      const configs: SloRouteConfig[] = [
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.01 },
        { method: 'GET', route: '/api/health' },
      ];

      initSloRecorder({
        configs,
        observationWindowMs: 600_000,
      });

      const all = getAllSloWindows();
      expect(all.size).toBe(2);
      expect(getSloWindow('POST', '/api/billing/deduct')).toBeDefined();
      expect(getSloWindow('get', '/api/health')).toBeDefined();
      expect(getSloWindow('GET', '/api/missing')).toBeUndefined();
    });

    it('drops duplicates (case-insensitive on method) and warns once', () => {
      // The recorder's `logger.warn` reflects a stable binding (the project's
      // logger wraps console.warn at module load), so we spy on it directly.
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      initSloRecorder({
        configs: [
          { method: 'POST', route: '/api/foo' },
          { method: 'post', route: '/api/foo' },
        ],
        observationWindowMs: 600_000,
      });
      expect(getAllSloWindows().size).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate SLO config'),
      );
      warn.mockRestore();
    });

    it('exposes its configs via getSloConfigs()', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxErrorRate: 0.05,
        maxLatencyP95Ms: 750,
      };
      initSloRecorder({ configs: [config], observationWindowMs: 600_000 });
      const configsByKey = getSloConfigs();
      expect(configsByKey.get(sloConfigKey('POST', '/api/billing/deduct'))).toEqual(config);
    });
  });

  describe('sloRecorderMiddleware', () => {
    it('records samples only for configured routes', () => {
      initSloRecorder({
        configs: [{ method: 'POST', route: '/api/billing/deduct' }],
        observationWindowMs: 600_000,
      });

      // Configured route
      const configured = buildReqRes({
        method: 'POST',
        path: '/api/billing/deduct',
        statusCode: 200,
      });
      sloRecorderMiddleware(configured.req, configured.res, jest.fn());
      configured.res.emit('finish');

      const window = getSloWindow('POST', '/api/billing/deduct');
      expect(window).toBeDefined();
      expect(window!.totalObservedRequests()).toBe(1);

      // Unconfigured route is a no-op (no window created, no crash).
      const other = buildReqRes({
        method: 'GET',
        path: '/api/health',
        statusCode: 200,
      });
      sloRecorderMiddleware(other.req, other.res, jest.fn());
      other.res.emit('finish');
      expect(window!.totalObservedRequests()).toBe(1);
    });

    it('aggregates multiple samples into the same window', () => {
      initSloRecorder({
        configs: [{ method: 'POST', route: '/api/billing/deduct' }],
        observationWindowMs: 600_000,
      });

      for (let i = 0; i < 5; i++) {
        const { req, res } = buildReqRes({
          method: 'POST',
          path: '/api/billing/deduct',
          statusCode: i === 2 ? 500 : 200,
        });
        sloRecorderMiddleware(req, res, jest.fn());
        res.emit('finish');
      }

      const metrics = getSloWindow('POST', '/api/billing/deduct')!.getMetrics();
      expect(metrics.totalRequests).toBe(5);
      expect(metrics.errorRate).toBeCloseTo(1 / 5, 6);
    });

    it('uses the matched Express route pattern (parameterised) for lookup', () => {
      initSloRecorder({
        configs: [{ method: 'POST', route: '/v1/call/:apiId' }],
        observationWindowMs: 600_000,
      });

      const { req, res } = buildReqRes({
        method: 'POST',
        path: '/v1/call/abc123xyz',
        routePath: '/v1/call/:apiId',
        statusCode: 200,
      });
      sloRecorderMiddleware(req, res, jest.fn());
      res.emit('finish');

      // The matched Express route pattern, not the raw URL, is keyed.
      const window = getSloWindow('POST', '/v1/call/:apiId');
      expect(window).toBeDefined();
      expect(window!.totalObservedRequests()).toBe(1);
    });

    it('swallows an error from the analysis window without crashing the request', () => {
      // Force an internal failure by spying on the analysis window after init.
      initSloRecorder({
        configs: [{ method: 'GET', route: '/api/bogus' }],
        observationWindowMs: 600_000,
      });
      const window = getSloWindow('GET', '/api/bogus')!;
      const errorSpy = jest
        .spyOn(window, 'addSample')
        .mockImplementation(() => {
          throw new Error('forced recorder failure');
        });
      // Spy on the logger directly — `console.error` is captured at module
      // load by the project's `wrapLog` helper and so jest.spyOn(console, ...)
      // does not intercept logger.error calls. Spying on `logger.error`
      // itself does.
      const loggerError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

      const { req, res } = buildReqRes({
        method: 'GET',
        path: '/api/bogus',
        statusCode: 200,
      });
      expect(() =>
        sloRecorderMiddleware(req, res, jest.fn()),
      ).not.toThrow();
      res.emit('finish');
      expect(loggerError).toHaveBeenCalledWith(
        '[sloAlertRecorder] Failed to record sample',
        expect.any(Error),
      );
      errorSpy.mockRestore();
      loggerError.mockRestore();
    });
  });
});
