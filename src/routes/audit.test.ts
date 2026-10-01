import express from 'express';
import request from 'supertest';

jest.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).developerId = 'dev-user-123';
    next();
  }
}));

import { createAuditRouter, AuditConfigRepository, AuditConfig } from './audit.js';
import { errorHandler } from '../middleware/errorHandler.js';

describe('/api/audit mutations', () => {
  let app: express.Express;
  let recordMock: jest.Mock;
  let repository: AuditConfigRepository;

  const buildApp = (options: { admin?: boolean } = {}) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).auditContext = {
        tenantId: 'tenant-1',
        clientIp: '127.0.0.1',
        userAgent: 'test-agent',
        correlationId: 'corr-1',
        bodyHash: 'hash-1',
      };
      if (options.admin) {
        (req as any).adminActor = 'admin-user-1';
      }
      next();
    });
    app.use('/api/audit', createAuditRouter({ auditService: { record: recordMock } as any, repository }));
    app.use(errorHandler);
    return app;
  };

  beforeEach(() => {
    recordMock = jest.fn().mockResolved(undefined);
    repository = {
      list: jest.fn().mockResolved([]),
      getById: jest.fn().mockResolved(undefined),
      create: jest.fn().mockImplementation(async (c: AuditConfig) => c),
      update: jest.fn().mockImplementation(async (_id: string, c: AuditConfig) => c),
      delete: jest.fn().mockResolved(true),
    };
    app = buildApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GQT /api/audit returns empty list initially', async () => {
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
    const existing: AuditConfig = { id: 'config-1', targetEndpoint: '/v1', enabled: true, createdBy: 'dev-user-123' };
    (repository.getById as jest.Mock).mockResolvedOnce(existing);

    const updateRes = await request(app).put('/api/audit/config-1').send({ targetEndpoint: '/v2' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.targetEndpoint).toBe('/v2');
    expect(updateRes.body.enabled).toBe(true);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_UPDATE');
    expect(callArgs.details.before).toEqual({ targetEndpoint: '/v1', enabled: true });
    expect(callArgs.details.after).toEqual({ targetEndpoint: '/v2', enabled: true });
  });

  it('PUT /api/audit/:id rejects invalid data', async () => {
    (repository.getById as jest.Mock).mockResolvedOnce({ id: 'config-1', targetEndpoint: '/v1', enabled: true, createdBy: 'dev-user-123' });
    const res = await request(app).put('/api/audit/config-1').send({ enabled: 'not-a-bool' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/audit/:id returns 404 for unknown ID', async () => {
    (repository.getById as jest.Mock).mockResolved(undefined);
    const res = await request(app).put('/api/audit/9999').send({ targetEndpoint: '/x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/audit/:id deletes config and logs AUDIT_CONFIG_DELETE', async () => {
    (repository.getById as jest.Mock).mockResolvedOnce({ id: 'config-1', targetEndpoint: '/del', enabled: false, createdBy: 'dev-user-123' });

    const delRes = await request(app).delete('/api/audit/config-1');
    expect(delRes.status).toBe(204);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_DELETE');
    expect(callArgs.details.before).toEqual({ targetEndpoint: '/del', enabled: false });
    expect(callArgs.details.after).toBeNull();
  });

  it('DELETE /api/audit/:id returns 404 for unknown ID', async () => {
    (repository.getById as jest.Mock).mockResolved(undefined);
    const res = await request(app).delete('/api/audit/9999');
    expect(res.status).toBe(404);
  });

  it('does not fail request if audit logging fails', async () => {
    recordMock.mockRejectedOnce(new Error('DB error'));

    const res = await request(app).post('/api/audit').send({
      targetEndpoint: '/fail-log',
      enabled: true
    });

    expect(res.status).toBe(201);
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('attributes mutations to adminActor when present', async () => {
    app = buildApp({ admin: true });
    const res = await request(app).post('/api/audit').send({
      targetEndpoint: '/admin-created',
      enabled: true,
    });
    expect(res.status).toBe(201);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.actor).toBe('admin-user-1');
  });

  it('non-admin users cannot modify or delete records they do not own', async () => {
    (repository.getById as jest.Mock).mockResolved({ id: 'config-1', targetEndpoint: '/v1', enabled: true, createdBy: 'other-user' });
    const updateRes = await request(app).put('/api/audit/config-1').send({ targetEndpoint: '/v2' });
    expect(updateRes.status).toBe(403);

    (repository.getById as jest.Mock).mockResolved({ enabled: true, id: 'config-1', targetEndpoint: '/v1', createdBy: 'other-user' });
    const delRes = await request(app).delete('/api/audit/config-1');
    expect(delRes.status).toBe(403);
  });
});
