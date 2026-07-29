import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import {
  LEGACY_V1_DEPRECATION_HEADER,
  LEGACY_V1_SUNSET_AT,
  legacyV1DeprecationMiddleware,
} from './deprecation.js';
import { logger } from './logging.js';

describe('legacyV1DeprecationMiddleware', () => {
  test('stamps deprecation headers and logs a structured warning with correlation id', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const req = {
        id: 'req-legacy-1',
        method: 'GET',
        path: '/v1/call/test-api/health',
        originalUrl: '/v1/call/test-api/health',
        header: jest.fn().mockReturnValue(undefined),
      } as unknown as Request;

      const res = new EventEmitter() as EventEmitter & Response & {
        statusCode: number;
        setHeader: jest.Mock;
      };
      res.statusCode = 200;
      res.setHeader = jest.fn();

      const next = jest.fn();

      legacyV1DeprecationMiddleware(req, res, next);
      res.emit('finish');

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith('Deprecation', LEGACY_V1_DEPRECATION_HEADER);
      expect(res.setHeader).toHaveBeenCalledWith('Sunset', LEGACY_V1_SUNSET_AT);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        {
          requestId: 'req-legacy-1',
          method: 'GET',
          path: '/v1/call/test-api/health',
          statusCode: 200,
          sunset: LEGACY_V1_SUNSET_AT,
          deprecated: true,
        },
        'legacy v1 endpoint accessed',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('falls back to sanitized x-request-id header when req.id is unavailable', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const req = {
        method: 'POST',
        path: '/v1/call/test-api/data',
        originalUrl: '/v1/call/test-api/data',
        header: jest.fn().mockImplementation((name: string) =>
          name.toLowerCase() === 'x-request-id' ? '  req-from-header  ' : undefined,
        ),
      } as unknown as Request;

      const res = new EventEmitter() as EventEmitter & Response & {
        statusCode: number;
        setHeader: jest.Mock;
      };
      res.statusCode = 401;
      res.setHeader = jest.fn();

      legacyV1DeprecationMiddleware(req, res, jest.fn());
      res.emit('finish');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-from-header',
          statusCode: 401,
          sunset: LEGACY_V1_SUNSET_AT,
        }),
        'legacy v1 endpoint accessed',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
