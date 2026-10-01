import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '../middleware/errorHandler.js';
import { 
  BadRequestError, 
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
  TooManyRequestsError,
  AppError,
} from '../errors/index.js';
import { ValidationError } from '../middleware/validate.js';
import { logger } from '../logger.js';
import type { ErrorEnvelope } from '../types/ResponseEnvelope.js';

jest.mock('../logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('Error Handler', () => {
  let mockReq: Partial<Request> & { id?: string };
  let mockRes: Partial<Response> & { destroy?: jest.Mock };
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      id: 'test-request-id'
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      destroy: jest.fn(),
      headersSent: false
    };
    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should handle AppError with correct error envelope shape', () => {
    const error = new BadRequestError('Test bad request');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call).toMatchObject({
      success: false,
      requestId: 'test-request-id',
    });
    expect(call.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Test bad request',
    });
    expect(typeof call.timestamp).toBe('string');

    expect(logger.error).toHaveBeenCalledWith(
      '[errorHandler]',
      expect.objectContaining({ requestId: 'test-request-id', statusCode: 400 })
    );
  });

  it('should handle generic Error with error envelope', () => {
    const error = new Error('Generic error');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call).toMatchObject({
      success: false,
      requestId: 'test-request-id',
    });
    expect(call.error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('should handle unknown error type', () => {
    const error = 'String error';
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.success).toBe(false);
    expect(call.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('should use unknown requestId when req.id is missing', () => {
    mockReq = {}; // No id property
    
    const error = new UnauthorizedError('Unauthorized');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.requestId).toBe('unknown');
  });

  describe('when headers were already sent (mid-stream failure)', () => {
    let destroy: jest.Mock;

    beforeEach(() => {
      destroy = jest.fn();
      Object.assign(mockRes, {
        headersSent: true,
        writableEnded: false,
        destroyed: false,
        destroy,
      });
    });

    it('does not write an envelope and destroys the response with the error', () => {
      const error = new Error('upstream reset mid-stream');

      errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledWith(error);
    });

    it('logs the error exactly once with the requestId', () => {
      errorHandler(new Error('boom'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        '[errorHandler]',
        expect.objectContaining({ requestId: 'test-request-id', headersSent: true }),
      );
    });

    it('does not delegate to next(err), which would log a second time', () => {
      errorHandler(new Error('boom'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
    });

    it('wraps non-Error throws so destroy always receives an Error', () => {
      errorHandler('string failure', mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(destroy).toHaveBeenCalledWith(expect.any(Error));
      expect((destroy.mock.calls[0][0] as Error).message).toBe('string failure');
    });

    it('maps AppErrors thrown mid-stream to a destroy, not a status change', () => {
      errorHandler(new BadRequestError('late'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(mockRes.status).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('leaves a cleanly ended response alone but still logs', () => {
      (mockRes as { writableEnded: boolean }).writableEnded = true;

      errorHandler(new Error('after end'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(destroy).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('does not destroy twice when the client already disconnected', () => {
      (mockRes as { destroyed: boolean }).destroyed = true;

      errorHandler(new Error('client gone'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

      expect(destroy).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('never throws if destroy itself fails', () => {
      destroy.mockImplementation(() => {
        throw new Error('destroy failed');
      });

      expect(() =>
        errorHandler(new Error('boom'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext),
      ).not.toThrow();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[errorHandler] failed to destroy response after headers sent',
        expect.objectContaining({ requestId: 'test-request-id' }),
      );
    });
  });

  it('leaves responses without headers sent unchanged (no destroy)', () => {
    const destroy = jest.fn();
    Object.assign(mockRes, { destroy, writableEnded: false, destroyed: false });

    errorHandler(new BadRequestError('Test error'), mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('terminates a real socket when a handler throws after res.write', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as Request & { id?: string }).id = 'real-socket-id';
      next();
    });
    app.get('/stream', (_req, res, next) => {
      res.status(200).set('content-length', '1000');
      res.write('{"partial":');
      setImmediate(() => next(new Error('failed after first chunk')));
    });
    app.use(errorHandler);

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const outcome = await new Promise<'aborted' | 'completed'>((resolve) => {
        const timeout = setTimeout(() => resolve('completed'), 2000);
        http
          .get({ port, path: '/stream', agent: false }, (res) => {
            res.on('data', () => undefined);
            res.on('end', () => { clearTimeout(timeout); resolve('completed'); });
            res.on('aborted', () => { clearTimeout(timeout); resolve('aborted'); });
            res.on('error', () => { clearTimeout(timeout); resolve('aborted'); });
            res.on('close', () => { clearTimeout(timeout); resolve(res.complete ? 'completed' : 'aborted'); });
          })
          .on('error', () => { clearTimeout(timeout); resolve('aborted'); });
      });

      expect(outcome).toBe('aborted');
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should destroy the socket when headers are already sent', () => {
    mockRes.headersSent = true;
    const error = new Error('mid-stream failure');

    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockRes.json).not.toHaveBeenCalled();
    expect(mockRes.destroy).toHaveBeenCalledWith(error);
  });

  it('logs the error once with requestId when headers are already sent', () => {
    mockRes.headersSent = true;
    const error = new Error('mid-stream failure');

    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[errorHandler]',
      expect.objectContaining({ requestId: 'test-request-id' })
    );
  });

  it('should include explicit catalog code when provided', () => {
    const error = new AppError('Custom error', 422, 'UNPROCESSABLE_ENTITY');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(422);
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call).toMatchObject({
      success: false,
      requestId: 'test-request-id',
    });
    expect(call.error).toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'Custom error',
    });
  });

  it('should include validation details for validation errors', () => {
    const error = new ValidationError([
      {
        field: 'body.endpoints[0].path',
        message: 'Invalid input: expected string, received undefined',
        code: 'INVALID_TYPE',
      },
    ]);

    errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.error.details).toBeDefined();
    expect(Array.isArray(call.error.details)).toBe(true);
  });

  it('should map ForbiddenError to 403', () => {
    const error = new ForbiddenError('Test forbidden');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.error.code).toBe('FORBIDDEN');
  });

  it('should map NotFoundError to 404', () => {
    const error = new NotFoundError('Test not found');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(404);
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.error.code).toBe('NOT_FOUND');
  });

  it('should map PaymentRequiredError to 402', () => {
    const error = new PaymentRequiredError('Test payment required');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(402);
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('should map TooManyRequestsError to 429', () => {
    const error = new TooManyRequestsError('Test too many requests');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(429);
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('all error envelopes have required fields', () => {
    const error = new BadRequestError('test');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorEnvelope>, mockNext);
    
    const call = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(call).toHaveProperty('success');
    expect(call).toHaveProperty('requestId');
    expect(call).toHaveProperty('timestamp');
    expect(call).toHaveProperty('error');
    expect(call.error).toHaveProperty('code');
    expect(call.error).toHaveProperty('message');
  });
});
