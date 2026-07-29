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

// ---------------------------------------------------------------------------
// Security header sweep — GrantFox FWC26 (#945)
// Verifies that every /api/errors response (success and error paths, across
// all HTTP verbs) carries the required security headers.
// ---------------------------------------------------------------------------

const EXPECTED_CSP_FRAGMENT = "default-src 'self'";
const EXPECTED_XCT = 'nosniff';
const EXPECTED_RP = 'strict-origin-when-cross-origin';

/** Shared no-op audit service for read-only and header-only tests. */
const noopAudit: AuditService = { record: jest.fn().mockResolvedValue(undefined) };

describe('/api/errors security headers (#945)', () => {
  beforeEach(() => {
    resetErrorStore();
  });

  // -----------------------------------------------------------------------
  // GET /api/errors — list (unauthenticated, public read)
  // -----------------------------------------------------------------------
  describe('GET /api/errors', () => {
    it('includes Content-Security-Policy with default-src self', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app).get('/api/errors');
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
    });

    it('includes X-Content-Type-Options: nosniff', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app).get('/api/errors');
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
    });

    it('includes Referrer-Policy: strict-origin-when-cross-origin', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app).get('/api/errors');
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/errors/:id — single record (404 error path)
  // -----------------------------------------------------------------------
  describe('GET /api/errors/:id — 404 error path', () => {
    it('includes all three security headers on a 404 response', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app).get('/api/errors/nonexistent');
      expect(res.status).toBe(404);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/errors — create (201 success path)
  // -----------------------------------------------------------------------
  describe('POST /api/errors', () => {
    it('includes all three security headers on a 201 Created response', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-sec-1')
        .send({ code: 'ERR_SEC_001', message: 'Security test', statusCode: 400 });
      expect(res.status).toBe(201);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });

    it('includes security headers on 401 Unauthorized response', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app)
        .post('/api/errors')
        .send({ code: 'ERR_SEC_001', message: 'Security test', statusCode: 400 });
      expect(res.status).toBe(401);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });

    it('includes security headers on 400 validation-error response', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-sec-1')
        .send({ message: 'Missing required fields' });
      expect(res.status).toBe(400);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /api/errors/:id — update (200 success path)
  // -----------------------------------------------------------------------
  describe('PATCH /api/errors/:id', () => {
    it('includes all three security headers on a 200 OK response', async () => {
      const app = buildApp(noopAudit);
      // Seed a record first
      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-sec-1')
        .send({ code: 'ERR_PATCH_SEED', message: 'Seed record', statusCode: 422 });

      const res = await request(app)
        .patch('/api/errors/1')
        .set('x-user-id', 'dev-sec-1')
        .send({ message: 'Updated security test message' });
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });

    it('includes security headers on 404 response for unknown resource', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app)
        .patch('/api/errors/9999')
        .set('x-user-id', 'dev-sec-1')
        .send({ message: 'Does not exist' });
      expect(res.status).toBe(404);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });
  });

  // -----------------------------------------------------------------------
  // PUT /api/errors/:id — full update
  // -----------------------------------------------------------------------
  describe('PUT /api/errors/:id', () => {
    it('includes all three security headers on a 200 OK response', async () => {
      const app = buildApp(noopAudit);
      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-sec-1')
        .send({ code: 'ERR_PUT_SEED', message: 'Seed for PUT', statusCode: 503 });

      const res = await request(app)
        .put('/api/errors/1')
        .set('x-user-id', 'dev-sec-1')
        .send({ code: 'ERR_PUT_UPDATED' });
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/errors/:id — deletion (204 No Content)
  // -----------------------------------------------------------------------
  describe('DELETE /api/errors/:id', () => {
    it('includes all three security headers on a 204 No Content response', async () => {
      const app = buildApp(noopAudit);
      await request(app)
        .post('/api/errors')
        .set('x-user-id', 'dev-sec-1')
        .send({ code: 'ERR_DEL_SEED', message: 'Seed for DELETE', statusCode: 500 });

      const res = await request(app)
        .delete('/api/errors/1')
        .set('x-user-id', 'dev-sec-1');
      expect(res.status).toBe(204);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });

    it('includes security headers on 404 response for unknown resource', async () => {
      const app = buildApp(noopAudit);
      const res = await request(app)
        .delete('/api/errors/9999')
        .set('x-user-id', 'dev-sec-1');
      expect(res.status).toBe(404);
      expect(res.headers['content-security-policy']).toContain(EXPECTED_CSP_FRAGMENT);
      expect(res.headers['x-content-type-options']).toBe(EXPECTED_XCT);
      expect(res.headers['referrer-policy']).toBe(EXPECTED_RP);
    });
  });
});
