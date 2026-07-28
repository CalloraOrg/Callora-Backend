import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import type { AuditService } from '../services/auditService.js';
import { createErrorsRouter, resetErrorStore } from './errors.js';

function buildApp(auditService: AuditService) {
  const app = express();
  app.use(express.json());
  // Attach req.auditContext mock or x-user-id mock for requireAuth compatibility
  app.use((req, _res, next) => {
    const userId = req.headers['x-user-id'] as string | undefined;
    if (userId) {
      (req as unknown as { developerId: string }).developerId = userId;
    }
    (req as unknown as { auditContext: Record<string, unknown> }).auditContext = {
      clientIp: '127.0.0.1',
      userAgent: 'jest-test',
      tenantId: userId ?? null,
      correlationId: (req.headers['x-request-id'] as string) ?? 'test-req-123',
      bodyHash: 'mock-hash',
    };
    next();
  });
  app.use('/api/errors', createErrorsRouter({ auditService }));
  app.use(errorHandler);
  return app;
}

const sampleErrorPayload = {
  code: 'ERR_TEST_001',
  message: 'Sample test error message',
  statusCode: 400,
  description: 'Sample description',
};

describe('/api/errors audit logging (#918)', () => {
  beforeEach(() => {
    resetErrorStore();
  });

  describe('POST /api/errors (Creation)', () => {
    it('persists an ERROR_CREATE audit row with before: null and after: newRecord on successful creation', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      const res = await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .set('x-request-id', 'req-corr-1')
        .send(sampleErrorPayload);

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          id: '1',
          code: 'ERR_TEST_001',
          message: 'Sample test error message',
          statusCode: 400,
        }),
      );

      expect(recordMock).toHaveBeenCalledTimes(1);
      const auditPayload = recordMock.mock.calls[0][0];
      expect(auditPayload).toEqual(
        expect.objectContaining({
          event: 'ERROR_CREATE',
          actor: 'dev-actor-1',
          correlationId: 'req-corr-1',
          clientIp: '127.0.0.1',
          userAgent: 'jest-test',
          tenantId: 'dev-actor-1',
          bodyHash: 'mock-hash',
        }),
      );
      expect(auditPayload.details).toEqual({
        errorId: '1',
        before: null,
        after: expect.objectContaining({
          id: '1',
          code: 'ERR_TEST_001',
          message: 'Sample test error message',
          statusCode: 400,
        }),
      });
    });

    it('does NOT create an audit entry if the request is unauthenticated (auth failure)', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      const res = await request(app).post('/api/errors').send(sampleErrorPayload);

      expect(res.status).toBe(401);
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('does NOT create an audit entry if request body validation fails', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      const res = await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send({ message: 'Invalid payload missing required fields' });

      expect(res.status).toBe(400);
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('does not fail the HTTP request if auditService.record throws an error (best-effort)', async () => {
      const recordMock = jest.fn().mockRejectedValue(new Error('Database write failure'));
      const app = buildApp({ record: recordMock });

      const res = await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send(sampleErrorPayload);

      expect(res.status).toBe(201);
      expect(recordMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('PUT /api/errors/:id & PATCH /api/errors/:id (Update)', () => {
    it('persists an ERROR_UPDATE audit row with before and after state snapshots', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      // First create a record
      const createRes = await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send(sampleErrorPayload);
      expect(createRes.status).toBe(201);
      recordMock.mockClear();

      // Perform update via PATCH
      const patchRes = await request(app)
        .patch('/api/errors/1')
        .set('x-user-id', 'dev-actor-1')
        .set('x-request-id', 'req-corr-update')
        .send({ message: 'Updated message' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.message).toBe('Updated message');

      expect(recordMock).toHaveBeenCalledTimes(1);
      const auditPayload = recordMock.mock.calls[0][0];
      expect(auditPayload).toEqual(
        expect.objectContaining({
          event: 'ERROR_UPDATE',
          actor: 'dev-actor-1',
          correlationId: 'req-corr-update',
        }),
      );
      expect(auditPayload.details.before).toEqual(
        expect.objectContaining({
          id: '1',
          message: 'Sample test error message',
        }),
      );
      expect(auditPayload.details.after).toEqual(
        expect.objectContaining({
          id: '1',
          message: 'Updated message',
        }),
      );
    });

    it('works with PUT method as well', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send(sampleErrorPayload);
      recordMock.mockClear();

      const putRes = await request(app)
        .put('/api/errors/1')
        .set('x-user-id', 'dev-actor-1')
        .send({ code: 'ERR_PUT_UPDATED' });

      expect(putRes.status).toBe(200);
      expect(recordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ERROR_UPDATE',
          actor: 'dev-actor-1',
        }),
      );
    });

    it('does NOT create an audit entry if resource is not found (404 pre-mutation failure)', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      const res = await request(app)
        .patch('/api/errors/9999')
        .set('x-user-id', 'dev-actor-1')
        .send({ message: 'Does not exist' });

      expect(res.status).toBe(404);
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('does NOT create an audit entry if update validation fails (400)', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send(sampleErrorPayload);
      recordMock.mockClear();

      // Empty update object fails Zod validation
      const res = await request(app)
        .patch('/api/errors/1')
        .set('x-user-id', 'dev-actor-1')
        .send({});

      expect(res.status).toBe(400);
      expect(recordMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/errors/:id (Deletion)', () => {
    it('persists an ERROR_DELETE audit row with before: deletedRecord and after: null', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send(sampleErrorPayload);
      recordMock.mockClear();

      const delRes = await request(app)
        .delete('/api/errors/1')
        .set('x-user-id', 'dev-actor-1')
        .set('x-request-id', 'req-corr-del');

      expect(delRes.status).toBe(204);

      expect(recordMock).toHaveBeenCalledTimes(1);
      const auditPayload = recordMock.mock.calls[0][0];
      expect(auditPayload).toEqual(
        expect.objectContaining({
          event: 'ERROR_DELETE',
          actor: 'dev-actor-1',
          correlationId: 'req-corr-del',
        }),
      );
      expect(auditPayload.details).toEqual({
        errorId: '1',
        before: expect.objectContaining({
          id: '1',
          code: 'ERR_TEST_001',
        }),
        after: null,
      });
    });

    it('does NOT create an audit entry if resource does not exist (404)', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      const res = await request(app)
        .delete('/api/errors/999')
        .set('x-user-id', 'dev-actor-1');

      expect(res.status).toBe(404);
      expect(recordMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/errors (Read-only endpoints)', () => {
    it('does NOT persist any audit rows for list and get-by-id queries', async () => {
      const recordMock = jest.fn().mockResolvedValue(undefined);
      const app = buildApp({ record: recordMock });

      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-actor-1')
        .send(sampleErrorPayload);
      recordMock.mockClear();

      const listRes = await request(app).get('/api/errors');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.errors).toHaveLength(1);
      expect(recordMock).not.toHaveBeenCalled();

      const getRes = await request(app).get('/api/errors/1');
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.id).toBe('1');
      expect(recordMock).not.toHaveBeenCalled();
    });
  });
});
