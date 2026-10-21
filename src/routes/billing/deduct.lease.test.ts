import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import deductRouter from './deduct.js';

jest.mock('../../middleware/requireAuth.js', () => ({
  requireAuth: (_req: Request, res: Response, next: NextFunction) => {
    res.locals.authenticatedUser = { id: 'user-1' };
    next();
  },
}));
jest.mock('../../middleware/idempotency.js', () => ({
  idempotencyMiddleware: (req: Request, res: Response, next: NextFunction) => {
    res.locals.idempotency = { renew: req.app.locals.renew };
    next();
  },
}));

const payload = { requestId: 'request-1', apiId: 'api-1', endpointId: 'endpoint-1', apiKeyId: 'key-1', amountUsdc: '1.00' };
function app(renew: jest.Mock, deduct: jest.Mock) {
  const server = express();
  server.use(express.json());
  server.locals.dbPool = {};
  server.locals.renew = renew;
  server.locals.billingService = { deduct };
  server.use('/', deductRouter);
  server.use((err: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: err.message }));
  return server;
}

describe('billing deduction lease renewal', () => {
  it('awaits renewal before and after the Soroban-backed deduction', async () => {
    const events: string[] = [];
    const renew = jest.fn(async () => { events.push('renew'); });
    const deduct = jest.fn(async () => { events.push('deduct'); return { success: true }; });
    expect((await request(app(renew, deduct)).post('/').send(payload)).status).toBe(200);
    expect(events).toEqual(['renew', 'deduct', 'renew']);
  });

  it('does not start a deduction after losing the lease', async () => {
    const renew = jest.fn().mockRejectedValue(new Error('ownership lost'));
    const deduct = jest.fn();
    expect((await request(app(renew, deduct)).post('/').send(payload)).status).toBe(500);
    expect(deduct).not.toHaveBeenCalled();
  });
});
