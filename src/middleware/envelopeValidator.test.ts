import { Request, Response, NextFunction } from 'express';
import {
  envelopeValidator,
  validateEnvelopeShape,
} from './envelopeValidator.js';
import type { SuccessEnvelope, ErrorEnvelope } from '../types/ResponseEnvelope.js';

describe('envelopeValidator', () => {
  describe('validateEnvelopeShape', () => {
    it('returns null for valid success envelope', () => {
      const envelope: SuccessEnvelope = {
        success: true,
        data: { id: 1, name: 'test' },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toBeNull();
    });

    it('returns null for valid error envelope', () => {
      const envelope: ErrorEnvelope = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
        },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toBeNull();
    });

    it('catches missing success field', () => {
      const envelope = {
        data: { id: 1 },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('Missing required field: "success"');
    });

    it('catches missing requestId field', () => {
      const envelope = {
        success: true,
        data: { id: 1 },
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('Missing required field: "requestId"');
    });

    it('catches missing timestamp field', () => {
      const envelope = {
        success: true,
        data: { id: 1 },
        requestId: 'req-123',
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('Missing required field: "timestamp"');
    });

    it('catches invalid timestamp format', () => {
      const envelope = {
        success: true,
        data: { id: 1 },
        requestId: 'req-123',
        timestamp: 'not-a-date',
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('must be a valid ISO 8601 date string');
    });

    it('catches success envelope missing data field', () => {
      const envelope = {
        success: true,
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('Success envelope missing required field: "data"');
    });

    it('catches error envelope missing error object', () => {
      const envelope = {
        success: false,
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('Error envelope missing required field: "error"');
    });

    it('catches error.code missing', () => {
      const envelope = {
        success: false,
        error: {
          message: 'Something went wrong',
        },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('"error.code" must be a string');
    });

    it('catches error.message missing', () => {
      const envelope = {
        success: false,
        error: {
          code: 'ERROR',
        },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toContain('"error.message" must be a string');
    });

    it('rejects array response', () => {
      const violation = validateEnvelopeShape([]);
      expect(violation).toContain('Response must be a plain object');
    });

    it('rejects null response', () => {
      const violation = validateEnvelopeShape(null);
      expect(violation).toContain('Response must be a plain object');
    });

    it('accepts success envelope with meta', () => {
      const envelope: SuccessEnvelope = {
        success: true,
        data: [{ id: 1 }, { id: 2 }],
        meta: { page: 1, perPage: 10, total: 100 },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toBeNull();
    });

    it('accepts error envelope with details', () => {
      const envelope: ErrorEnvelope = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: [{ field: 'email', issue: 'invalid format' }],
        },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      const violation = validateEnvelopeShape(envelope);
      expect(violation).toBeNull();
    });
  });

  describe('envelopeValidator middleware', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: NextFunction;

    beforeEach(() => {
      mockReq = {
        method: 'GET',
        path: '/api/test',
      };
      mockRes = {
        json: jest.fn().mockReturnThis(),
      };
      mockNext = jest.fn();
    });

    it('intercepts res.json and validates', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test'; // Skip validation in test mode

      envelopeValidator(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      // Call res.json with valid envelope
      const validEnvelope = {
        success: true,
        data: { id: 1 },
        requestId: 'req-123',
        timestamp: new Date().toISOString(),
      };

      (mockRes.json as jest.Mock)(validEnvelope);
      expect(mockNext).toHaveBeenCalled();

      process.env.NODE_ENV = origEnv;
    });

    it('throws in development mode on invalid envelope', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      envelopeValidator(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      // Call res.json with invalid envelope
      const invalidEnvelope = { data: { id: 1 } }; // Missing success, requestId, timestamp

      expect(() => {
        (mockRes.json as jest.Mock)(invalidEnvelope);
      }).toThrow();

      process.env.NODE_ENV = origEnv;
    });

    it('warns in production mode on invalid envelope but still sends', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      envelopeValidator(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      // Call res.json with invalid envelope
      const invalidEnvelope = { data: { id: 1 } }; // Missing success, requestId, timestamp

      expect(() => {
        (mockRes.json as jest.Mock)(invalidEnvelope);
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();

      warnSpy.mockRestore();
      process.env.NODE_ENV = origEnv;
    });
  });
});
