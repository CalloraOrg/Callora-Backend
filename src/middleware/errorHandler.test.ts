import { Request, Response, NextFunction } from 'express';
import { errorHandler, ErrorResponseBody } from '../middleware/errorHandler.js';
import { AppError, BadRequestError, UnauthorizedError } from '../errors/index.js';

describe('Error Handler', () => {
  let mockReq: Partial<Request>;
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
});
