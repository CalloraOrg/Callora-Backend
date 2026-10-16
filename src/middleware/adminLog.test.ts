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

  it('mounts each /api/admin router only once in createApp in specific-before-generic order (#1239)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const appSource: string = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app.ts'),
      'utf8',
    );

    const anomaliesMatches = appSource.match(/app\.use\(\s*['"]\/api\/admin\/usage\/anomalies['"]/g) ?? [];
    const byEndpointMatches = appSource.match(/app\.use\(\s*['"]\/api\/admin\/usage\/by-endpoint['"]/g) ?? [];
    const spikeMatches = appSource.match(/app\.use\(\s*['"]\/api\/admin\/usage\/spike['"]/g) ?? [];
    const explainMatches = appSource.match(/app\.use\(\s*['"]\/api\/admin\/db\/explain['"]/g) ?? [];
    const genericAdminMatches = appSource.match(/app\.use\(\s*['"]\/api\/admin['"]\s*,/g) ?? [];

    expect(anomaliesMatches).toHaveLength(1);
    expect(byEndpointMatches).toHaveLength(1);
    expect(spikeMatches).toHaveLength(1);
    expect(explainMatches).toHaveLength(1);
    expect(genericAdminMatches).toHaveLength(1);

    const genericAdminIndex = appSource.search(/app\.use\(\s*['"]\/api\/admin['"]\s*,/);
    expect(appSource.search(/app\.use\(\s*['"]\/api\/admin\/usage\/anomalies['"]/)).toBeLessThan(genericAdminIndex);
    expect(appSource.search(/app\.use\(\s*['"]\/api\/admin\/usage\/by-endpoint['"]/)).toBeLessThan(genericAdminIndex);
    expect(appSource.search(/app\.use\(\s*['"]\/api\/admin\/usage\/spike['"]/)).toBeLessThan(genericAdminIndex);
    expect(appSource.search(/app\.use\(\s*['"]\/api\/admin\/db\/explain['"]/)).toBeLessThan(genericAdminIndex);
  });
});
