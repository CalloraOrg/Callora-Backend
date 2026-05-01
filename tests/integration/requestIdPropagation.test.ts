import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../src/middleware/requestId.js';
import { requestLogger, logger as pinoLogger } from '../../src/middleware/logging.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { BadRequestError } from '../../src/errors/index.js';
import { logger as customLogger } from '../../src/logger.js';

describe('Request ID Propagation', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    jest.spyOn(pinoLogger, 'info').mockImplementation(() => undefined as any);
    jest.spyOn(pinoLogger, 'warn').mockImplementation(() => undefined as any);
    jest.spyOn(pinoLogger, 'error').mockImplementation(() => undefined as any);

    jest.spyOn(customLogger, 'error').mockImplementation(() => undefined as any);

    app = express();
    app.use(requestIdMiddleware);
    app.use(requestLogger);

    app.get('/success', (req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/error', (req, res, next) => {
      next(new BadRequestError('Test bad request'));
    });

    app.use(errorHandler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should propagate a valid generated UUID to the response header and logger for successful requests', async () => {
    const response = await request(app).get('/success');

    expect(response.status).toBe(200);
    const requestId = response.headers['x-request-id'];
    expect(requestId).toBeDefined();
    
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(requestId).toMatch(uuidRegex);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(pinoLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: requestId,
        statusCode: 200,
        path: '/success'
      }),
      'request completed'
    );
  });

  it('should propagate the exact same UUID to error response body and error logger', async () => {
    const response = await request(app).get('/error');

    expect(response.status).toBe(400);
    const headerRequestId = response.headers['x-request-id'];
    const bodyRequestId = response.body.requestId;
    
    expect(headerRequestId).toBeDefined();
    expect(bodyRequestId).toBeDefined();
    expect(headerRequestId).toBe(bodyRequestId);

    expect(customLogger.error).toHaveBeenCalledWith(
      '[errorHandler]',
      expect.objectContaining({
        requestId: headerRequestId,
        statusCode: 400
      })
    );

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(pinoLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: headerRequestId,
        statusCode: 400,
        path: '/error'
      }),
      'request completed'
    );
  });

  it('should use provided valid UUID and propagate it', async () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000';
    const response = await request(app)
      .get('/success')
      .set('X-Request-Id', validUuid);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(validUuid);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(pinoLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: validUuid
      }),
      'request completed'
    );
  });

  it('should reject invalid X-Request-Id (e.g. PII) and generate a new UUID', async () => {
    const invalidId = 'john.doe@example.com';
    const response = await request(app)
      .get('/error')
      .set('X-Request-Id', invalidId);

    expect(response.status).toBe(400);
    const headerRequestId = response.headers['x-request-id'];
    
    expect(headerRequestId).toBeDefined();
    expect(headerRequestId).not.toBe(invalidId);
    
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(headerRequestId).toMatch(uuidRegex);
    expect(response.body.requestId).toBe(headerRequestId);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(customLogger.error).toHaveBeenCalledWith(
      '[errorHandler]',
      expect.objectContaining({
        requestId: headerRequestId
      })
    );
  });
});
