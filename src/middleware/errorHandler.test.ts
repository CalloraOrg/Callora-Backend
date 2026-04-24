import { Request, Response, NextFunction } from 'express';
import { errorHandler, ErrorResponseBody } from '../middleware/errorHandler.js';
import { 
  AppError, 
  BadRequestError, 
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
  TooManyRequestsError
} from '../errors/index.js';
import { ValidationError } from '../middleware/validate.js';
import { logger } from '../logger.js';

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

  it('should handle AppError with correct response shape', () => {
    const error = new BadRequestError('Test bad request');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Test bad request',
      code: 'BAD_REQUEST',
      requestId: 'test-request-id'
    });

    expect(logger.error).toHaveBeenCalledWith(
      '[errorHandler]',
      expect.objectContaining({ requestId: 'test-request-id', statusCode: 400 })
    );
  });

  it('should handle generic Error with default values', () => {
    const error = new Error('Generic error');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Generic error',
      requestId: 'test-request-id'
    });

    expect(logger.error).toHaveBeenCalledWith(
      '[errorHandler]',
      expect.objectContaining({ requestId: 'test-request-id', statusCode: 500 })
    );
  });

  it('should handle unknown error type', () => {
    const error = 'String error';
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Internal server error',
      requestId: 'test-request-id'
    });
  });

  it('should use unknown requestId when req.id is missing', () => {
    mockReq = {}; // No id property
    
    const error = new UnauthorizedError('Unauthorized');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      requestId: 'unknown'
    });
  });

  it('should not send response if headers already sent', () => {
    mockRes.headersSent = true;
    const error = new BadRequestError('Test error');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockRes.json).not.toHaveBeenCalled();
  });

  it('should include custom code when provided', () => {
    const error = new AppError('Custom error', 422, 'CUSTOM_CODE');
    
    errorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(422);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Custom error',
      code: 'CUSTOM_CODE',
      requestId: 'test-request-id'
    });
  });

<<<<<<< HEAD
  it('should include validation details for validation errors', () => {
    const error = new ValidationError([
      {
        field: 'body.endpoints[0].path',
        message: 'Invalid input: expected string, received undefined',
        code: 'INVALID_TYPE',
      },
    ]);

    errorHandler(
=======
  it('should map ForbiddenError to 403', () => {
    const error = new ForbiddenError('Test forbidden');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorResponseBody>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Test forbidden',
      code: 'FORBIDDEN'
    }));
  });

  it('should map NotFoundError to 404', () => {
    const error = new NotFoundError('Test not found');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorResponseBody>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Test not found',
      code: 'NOT_FOUND'
    }));
  });

  it('should map PaymentRequiredError to 402', () => {
    const error = new PaymentRequiredError('Test payment required');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorResponseBody>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Test payment required',
      code: 'PAYMENT_REQUIRED'
    }));
  });

  it('should map TooManyRequestsError to 429', () => {
    const error = new TooManyRequestsError('Test too many requests');
    errorHandler(error, mockReq as Request, mockRes as Response<ErrorResponseBody>, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(429);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Test too many requests',
      code: 'TOO_MANY_REQUESTS'
    }));
  });
});

describe('Error Handler - Production Environment', () => {
  let mockReq: Partial<Request> & { id?: string };
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let productionErrorHandler: typeof errorHandler;

  beforeEach(() => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      // Re-require to pick up the env change
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { errorHandler: eh } = require('../middleware/errorHandler.js');
      productionErrorHandler = eh;
    });

    mockReq = { id: 'prod-request-id' };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      headersSent: false
    };
    mockNext = jest.fn();
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
  });

  it('should mask generic error message in production', () => {
    const error = new Error('Sensitive database error message');
    
    productionErrorHandler(
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Internal server error',
      requestId: 'prod-request-id'
    });
  });

  it('should NOT mask AppError messages in production', () => {
    const error = new BadRequestError('User-facing validation error');
    
    productionErrorHandler(
>>>>>>> upstream/main
      error,
      mockReq as Request,
      mockRes as Response<ErrorResponseBody>,
      mockNext
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
<<<<<<< HEAD
      error: 'Request validation failed',
      code: 'VALIDATION_ERROR',
      requestId: 'test-request-id',
      details: [
        {
          field: 'body.endpoints[0].path',
          message: 'Invalid input: expected string, received undefined',
          code: 'INVALID_TYPE',
        },
      ],
=======
      error: 'User-facing validation error',
      code: 'BAD_REQUEST',
      requestId: 'prod-request-id'
>>>>>>> upstream/main
    });
  });
});
