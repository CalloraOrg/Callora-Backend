import express from 'express';
import request from 'supertest';

jest.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).developerId = 'dev-user-123';
    next();
  }
}));

import { createAuditRouter } from './audit.js';
import { errorHandler } from '../middleware/errorHandler.js';

describe('/api/audit mutations', () => {
  let app: express.Express;
  let recordMock: jest.Mock;

  beforeEach(() => {
    recordMock = jest.fn().mockResolvedValue(undefined);
    app = express();
    app.use(express.json());
    
    // Inject a dummy auditContext
    app.use((req, _res, next) => {
      (req as any).auditContext = {
        tenantId: 'tenant-1',
        clientIp: '127.0.0.1',
        userAgent: 'test-agent',
        correlationId: 'corr-1',
        bodyHash: 'hash-1',
      };
      next();
    });

    app.use('/api/audit', createAuditRouter({ auditService: { record: recordMock } }));
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/audit returns empty list initially', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('sets the required security headers on audit responses', async () => {
    const res = await request(app).get('/api/audit');

    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('POST /api/audit creates a new config and logs AUDIT_CONFIG_CREATE', async () => {
    const res = await request(app).post('/api/audit').send({
      targetEndpoint: '/users',
      enabled: false
    });

    expect(res.status).toBe(201);
    expect(res.body.targetEndpoint).toBe('/users');
    expect(res.body.enabled).toBe(false);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_CREATE');
    expect(callArgs.actor).toBe('dev-user-123');
    expect(callArgs.correlationId).toBe('corr-1');
    expect(callArgs.details).toMatchObject({
      auditConfigId: res.body.id,
      before: null,
      after: { targetEndpoint: '/users', enabled: false }
    });
  });

  it('POST /api/audit rejects invalid targetEndpoint', async () => {
    const res = await request(app).post('/api/audit').send({
      enabled: true
    });
    expect(res.status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('PUT /api/audit/:id updates config and logs AUDIT_CONFIG_UPDATE', async () => {
    // Create first
    const createRes = await request(app).post('/api/audit').send({ targetEndpoint: '/v1', enabled: true });
    const id = createRes.body.id;
    recordMock.mockClear();

    // Update
    const updateRes = await request(app).put(`/api/audit/${id}`).send({ targetEndpoint: '/v2' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.targetEndpoint).toBe('/v2');
    expect(updateRes.body.enabled).toBe(true); // kept old value

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_UPDATE');
    expect(callArgs.details.before).toEqual({ targetEndpoint: '/v1', enabled: true });
    expect(callArgs.details.after).toEqual({ targetEndpoint: '/v2', enabled: true });
  });

  it('PUT /api/audit/:id rejects invalid data', async () => {
    const createRes = await request(app).post('/api/audit').send({ targetEndpoint: '/v1', enabled: true });
    const id = createRes.body.id;
    
    const res = await request(app).put(`/api/audit/${id}`).send({ enabled: 'not-a-bool' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/audit/:id returns 404 for unknown ID', async () => {
    const res = await request(app).put('/api/audit/9999').send({ targetEndpoint: '/x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/audit/:id deletes config and logs AUDIT_CONFIG_DELETE', async () => {
    const createRes = await request(app).post('/api/audit').send({ targetEndpoint: '/del', enabled: false });
    const id = createRes.body.id;
    recordMock.mockClear();

    const delRes = await request(app).delete(`/api/audit/${id}`);
    expect(delRes.status).toBe(204);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_DELETE');
    expect(callArgs.details.before).toEqual({ targetEndpoint: '/del', enabled: false });
    expect(callArgs.details.after).toBeNull();
  });

  it('DELETE /api/audit/:id returns 404 for unknown ID', async () => {
    const res = await request(app).delete('/api/audit/9999');
    expect(res.status).toBe(404);
  });
  
  it('does not fail request if audit logging fails', async () => {
    recordMock.mockRejectedValueOnce(new Error('DB error'));
    
    const res = await request(app).post('/api/audit').send({
      targetEndpoint: '/fail-log',
      enabled: true
    });

    expect(res.status).toBe(201); // Request still succeeds
    expect(recordMock).toHaveBeenCalledTimes(1);
  });
});
