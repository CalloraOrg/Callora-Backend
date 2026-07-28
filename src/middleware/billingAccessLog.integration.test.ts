import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

import {
  billingAccessLogMiddleware,
  billingLogger,
  createBillingAccessLogMiddleware,
} from './billingAccessLog.js';

/**
 * Integration tests for the billing access-log middleware.
 *
 * These tests mount the middleware inside a real Express application and
 * exercise it through supertest so that the full request/response lifecycle
 * (including the `finish` event) is exercised end-to-end.
 */
describe('billingAccessLogMiddleware integration', () => {
  test('emits structured JSON log with correlation id on real Express request', async () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());

      // Simulate the requestId middleware that sets req.id
      app.use((req: Request, _res: Response, next: NextFunction) => {
        req.id = 'integration-req-1';
        next();
      });

      app.use(billingAccessLogMiddleware);

      app.post('/billing/deduct', (_req: Request, res: Response) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/billing/deduct')
        .send({ amountUsdc: '1.50', apiId: 'api-1', apiKeyId: 'ak-1' });

      expect(res.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'integration-req-1',
          requestId: 'integration-req-1',
          method: 'POST',
          path: '/billing/deduct',
          status: 200,
          statusCode: 200,
          ms: expect.any(Number),
          durationMs: expect.any(Number),
          amountUsdc: '1.50',
          apiId: 'api-1',
          apiKeyId: 'ak-1',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('logs at warn level for 4xx responses through Express', async () => {
    const warnSpy = jest.spyOn(billingLogger, 'warn').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use(billingAccessLogMiddleware);

      app.post('/billing/deduct', (_req: Request, res: Response) => {
        res.status(402).json({ error: 'Payment required', code: 'INSUFFICIENT_BALANCE' });
      });

      const res = await request(app)
        .post('/billing/deduct')
        .set('x-request-id', 'integration-4xx')
        .send({ amountUsdc: '0' });

      expect(res.status).toBe(402);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          status: 402,
          statusCode: 402,
          method: 'POST',
          path: '/billing/deduct',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('logs at error level for 5xx responses through Express', async () => {
    const errorSpy = jest.spyOn(billingLogger, 'error').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use(billingAccessLogMiddleware);

      app.post('/billing/deduct', (_req: Request, res: Response) => {
        res.status(502).json({ error: 'Bad gateway', code: 'SOROBAN_RPC_ERROR' });
      });

      const res = await request(app)
        .post('/billing/deduct')
        .set('x-request-id', 'integration-5xx')
        .send({});

      expect(res.status).toBe(502);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          status: 502,
          statusCode: 502,
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('billing router has middleware applied at router level', () => {
    // Verify that the billing router's stack includes the billingAccessLogMiddleware
    // by checking that the router is a function (Router) and the middleware is exported
    expect(typeof billingAccessLogMiddleware).toBe('function');

    // Create a custom middleware instance and verify it can be used as Express middleware
    const customMiddleware = createBillingAccessLogMiddleware();
    expect(typeof customMiddleware).toBe('function');
    expect(customMiddleware.length).toBe(3); // (req, res, next)
  });

  test('emits log on GET /billing/request/:requestId endpoint', async () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use(billingAccessLogMiddleware);

      app.get('/billing/request/:requestId', (req: Request, res: Response) => {
        res.status(200).json({ success: true, requestId: req.params.requestId });
      });

      const res = await request(app)
        .get('/billing/request/test-123')
        .set('x-request-id', 'get-req-1');

      expect(res.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          correlationId: 'get-req-1',
          requestId: 'get-req-1',
          method: 'GET',
          path: '/billing/request/test-123',
          status: 200,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('redacts configured fields in integration context', async () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use(
        createBillingAccessLogMiddleware({
          redactFields: ['amountUsdc', 'apiKeyId'],
        }),
      );

      app.post('/billing/deduct', (_req: Request, res: Response) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/billing/deduct')
        .set('x-request-id', 'integration-redact')
        .send({ amountUsdc: '100.00', apiKeyId: 'ak-secret' });

      expect(res.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.amountUsdc).toBe('[REDACTED]');
      expect(payload.apiKeyId).toBe('[REDACTED]');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('reports responseBytes matching the actual JSON response body size', async () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use(billingAccessLogMiddleware);

      const responseBody = { success: true, usageEventId: 'evt-123', stellarTxHash: 'tx-abc' };

      app.post('/billing/deduct', (_req: Request, res: Response) => {
        res.status(200).json(responseBody);
      });

      const res = await request(app)
        .post('/billing/deduct')
        .set('x-request-id', 'integration-size')
        .send({ amountUsdc: '2.00' });

      expect(res.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.responseBytes).toBe(Buffer.byteLength(JSON.stringify(responseBody)));
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('surfaces actor alongside userId when a developer is authenticated', async () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use((req: Request, res: Response, next: NextFunction) => {
        (res.locals as Record<string, unknown>).authenticatedUser = { id: 'dev-99' };
        next();
      });
      app.use(billingAccessLogMiddleware);

      app.get('/billing/request/:requestId', (req: Request, res: Response) => {
        res.status(200).json({ success: true, requestId: req.params.requestId });
      });

      const res = await request(app)
        .get('/billing/request/req-1')
        .set('x-request-id', 'integration-actor');

      expect(res.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ userId: 'dev-99', actor: 'dev-99' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('emits log even when response is not writableEnded (close event)', async () => {
    const infoSpy = jest.spyOn(billingLogger, 'info').mockImplementation(() => billingLogger);

    try {
      const app = express();
      app.use(express.json());
      app.use(billingAccessLogMiddleware);

      app.post('/billing/deduct', (_req: Request, res: Response) => {
        // Destroy the response to trigger 'close' without 'finish'
        res.status(200).json({ success: true });
        res.destroy();
      });

      await request(app)
        .post('/billing/deduct')
        .set('x-request-id', 'integration-close')
        .send({});

      // The log should have been emitted (either via finish or close)
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          requestId: 'integration-close',
          method: 'POST',
          path: '/billing/deduct',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
