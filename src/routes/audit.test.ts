import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { AuditService } from '../services/auditService.js';

jest.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.developerId = req.header('x-developer-id') ?? 'dev-user-123';
    next();
  }
}));

import { createAuditRouter } from './audit.js';
import { errorHandler } from '../middleware/errorHandler.js';

describe('/api/audit mutations', () => {
  let app: express.Express;
  let recordMock: jest.Mock<AuditService['record']>;
  const createdOwners = new Map<string, string>();

  const buildApp = (options: { admin?: boolean } = {}) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.auditContext = {
        adminActor: options.admin ? 'admin-user-1' : null,
        tenantId: 'tenant-1',
        clientIp: '127.0.0.1',
        userAgent: 'test-agent',
        correlationId: 'corr-1',
        bodyHash: 'hash-1',
      };
      if (options.admin) {
        res.locals.adminActor = 'admin-user-1';
      }
      next();
    });
    app.use('/api/audit', createAuditRouter({ auditService: { record: recordMock } }));
    app.use(errorHandler);
    return app;
  };

  beforeEach(() => {
    recordMock = jest.fn<AuditService['record']>().mockResolvedValue(undefined);
    app = buildApp();
  });

  afterEach(async () => {
    const listed = await request(app).get('/api/audit').expect(200);
    for (const config of listed.body.data) {
      await request(app)
        .delete(`/api/audit/${config.id}`)
        .set('x-developer-id', createdOwners.get(config.id) ?? 'dev-user-123')
        .expect(204);
    }
    createdOwners.clear();
    jest.clearAllMocks();
  });

  async function seedConfig(targetEndpoint: string, enabled: boolean, developerId = 'dev-user-123') {
    const created = await request(app)
      .post('/api/audit')
      .set('x-developer-id', developerId)
      .send({ targetEndpoint, enabled })
      .expect(201);
    const id: string = created.body.id;
    createdOwners.set(id, developerId);
    recordMock.mockClear();
    return id;
  }

  it('GET /api/audit returns an empty list initially', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
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
    const id = await seedConfig('/v1', true);

    const updateRes = await request(app).put(`/api/audit/${id}`).send({ targetEndpoint: '/v2' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.targetEndpoint).toBe('/v2');
    expect(updateRes.body.enabled).toBe(true);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_UPDATE');
    expect(callArgs.details).toMatchObject({
      before: { targetEndpoint: '/v1', enabled: true },
      after: { targetEndpoint: '/v2', enabled: true },
    });
  });

  it('PUT /api/audit/:id rejects invalid data', async () => {
    const id = await seedConfig('/v1', true);
    const res = await request(app).put(`/api/audit/${id}`).send({ enabled: 'not-a-bool' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/audit/:id returns 404 for unknown ID', async () => {
    const res = await request(app).put('/api/audit/9999').send({ targetEndpoint: '/x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/audit/:id deletes config and logs AUDIT_CONFIG_DELETE', async () => {
    const id = await seedConfig('/del', false);

    const delRes = await request(app).delete(`/api/audit/${id}`);
    expect(delRes.status).toBe(204);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const callArgs = recordMock.mock.calls[0][0];
    expect(callArgs.event).toBe('AUDIT_CONFIG_DELETE');
    expect(callArgs.details).toMatchObject({
      before: { targetEndpoint: '/del', enabled: false },
      after: null,
    });
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
    const id = await seedConfig('/v1', true, 'other-user');
    const updateRes = await request(app).put(`/api/audit/${id}`).send({ targetEndpoint: '/v2' });
    expect(updateRes.status).toBe(403);

    const delRes = await request(app).delete(`/api/audit/${id}`);
    expect(delRes.status).toBe(403);
  });
});
