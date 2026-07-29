import { Request, Response, NextFunction } from 'express';
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
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      id: 'test-request-id'
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
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

  it('should not send response if headers already sent', () => {
    mockRes.headersSent = true;
    const error = new BadRequestError('Test error');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorEnvelope>,
      mockNext
    );

    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockRes.json).not.toHaveBeenCalled();
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
