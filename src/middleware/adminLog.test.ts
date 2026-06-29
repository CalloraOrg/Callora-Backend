import { adminLogMiddleware, adminLogger } from './adminLog.js';
import { type Request, type Response } from 'express';

describe('Admin Logging Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(adminLogger, 'info').mockImplementation(() => adminLogger);

    mockRequest = {
      method: 'POST',
      path: '/users',
      baseUrl: '/api/admin',
      ip: '127.0.0.1',
      get: jest.fn().mockReturnValue('test-agent'),
    };

    const callbacks: Record<string, () => void> = {};
    mockResponse = {
      statusCode: 201,
      locals: { adminActor: 'admin@callora.io' },
      on: jest.fn().mockImplementation((event, callback) => {
        callbacks[event] = callback;
        return mockResponse;
      }),
    };

    // Simulate response ending to trigger the logger
    (mockResponse.on as jest.Mock).mockImplementation((event, callback) => {
      if (event === 'finish') setTimeout(callback, 0);
        return mockResponse;
    });
  });

  it('should successfully pass to next and log structured admin metadata', (done) => {
    adminLogMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    
    setTimeout(() => {
      expect(adminLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/api/admin/users',
          statusCode: 201,
          actor: 'admin@callora.io',
        }),
        expect.any(String)
      );
      done();
    }, 5);
  });
});
