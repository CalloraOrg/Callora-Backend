import { successEnvelope, errorEnvelope, getRequestId } from './envelope.js';
import type { SuccessEnvelope, ErrorEnvelope } from '../types/ResponseEnvelope.js';

describe('Envelope Helpers', () => {
  describe('successEnvelope', () => {
    it('creates a valid success envelope with data and requestId', () => {
      const data = { id: 1, name: 'Test' };
      const requestId = 'req-123';

      const envelope = successEnvelope(data, requestId);

      expect(envelope.success).toBe(true);
      expect(envelope.data).toEqual(data);
      expect(envelope.requestId).toBe(requestId);
      expect(envelope.timestamp).toBeDefined();
      expect(typeof envelope.timestamp).toBe('string');
    });

    it('creates envelope with meta when provided', () => {
      const data = [1, 2, 3];
      const requestId = 'req-123';
      const meta = { page: 1, perPage: 10, total: 100 };

      const envelope = successEnvelope(data, requestId, meta);

      expect(envelope.success).toBe(true);
      expect(envelope.data).toEqual(data);
      expect(envelope.meta).toEqual(meta);
      expect(envelope.requestId).toBe(requestId);
    });

    it('does not include meta field when not provided', () => {
      const data = { id: 1 };
      const requestId = 'req-123';

      const envelope = successEnvelope(data, requestId);

      expect(envelope).not.toHaveProperty('meta');
    });

    it('timestamp is valid ISO 8601 string', () => {
      const envelope = successEnvelope({ id: 1 }, 'req-123');

      expect(() => new Date(envelope.timestamp)).not.toThrow();
      expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('works with various data types', () => {
      const envelope1 = successEnvelope({ nested: { value: 'test' } }, 'req-1');
      expect(envelope1.data).toEqual({ nested: { value: 'test' } });

      const envelope2 = successEnvelope([1, 2, 3], 'req-2');
      expect(envelope2.data).toEqual([1, 2, 3]);

      const envelope3 = successEnvelope(null, 'req-3');
      expect(envelope3.data).toBeNull();

      const envelope4 = successEnvelope('string', 'req-4');
      expect(envelope4.data).toBe('string');
    });
  });

  describe('errorEnvelope', () => {
    it('creates a valid error envelope', () => {
      const code = 'NOT_FOUND';
      const message = 'Resource not found';
      const requestId = 'req-123';

      const envelope = errorEnvelope(code, message, requestId);

      expect(envelope.success).toBe(false);
      expect(envelope.error.code).toBe(code);
      expect(envelope.error.message).toBe(message);
      expect(envelope.requestId).toBe(requestId);
      expect(envelope.timestamp).toBeDefined();
    });

    it('includes details when provided', () => {
      const code = 'VALIDATION_ERROR';
      const message = 'Invalid input';
      const requestId = 'req-123';
      const details = { field: 'email', issue: 'invalid format' };

      const envelope = errorEnvelope(code, message, requestId, details);

      expect(envelope.error.details).toEqual(details);
    });

    it('does not include details field when undefined', () => {
      const envelope = errorEnvelope('ERROR', 'Error occurred', 'req-123');

      expect(envelope.error).not.toHaveProperty('details');
    });

    it('timestamp is valid ISO 8601 string', () => {
      const envelope = errorEnvelope('ERROR', 'msg', 'req-123');

      expect(() => new Date(envelope.timestamp)).not.toThrow();
      expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('handles complex details objects', () => {
      const details = {
        errors: [
          { field: 'email', message: 'Invalid' },
          { field: 'phone', message: 'Required' },
        ],
      };

      const envelope = errorEnvelope('VALIDATION', 'Failed', 'req-123', details);

      expect(envelope.error.details).toEqual(details);
    });
  });

  describe('getRequestId', () => {
    it('extracts requestId from x-request-id header', () => {
      const req = {
        headers: { 'x-request-id': 'client-id-123' },
      };

      const id = getRequestId(req);

      expect(id).toBe('client-id-123');
    });

    it('handles array header values (uses first element)', () => {
      const req = {
        headers: { 'x-request-id': ['client-id-123', 'other'] },
      };

      const id = getRequestId(req);

      expect(id).toBe('client-id-123');
    });

    it('generates UUID when header not present', () => {
      const req = {
        headers: {},
      };

      const id = getRequestId(req);

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      // UUID v4 format check (rough)
      expect(id.length).toBeGreaterThan(20);
    });

    it('generates UUID when header is undefined', () => {
      const req = {
        headers: { 'x-request-id': undefined },
      };

      const id = getRequestId(req);

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('returns client-supplied ID with priority', () => {
      const clientId = 'my-custom-trace-id';
      const req = {
        headers: { 'x-request-id': clientId },
      };

      const id = getRequestId(req);

      expect(id).toBe(clientId);
    });
  });

  describe('Type safety', () => {
    it('successEnvelope is typed correctly', () => {
      const envelope: SuccessEnvelope<{ id: number }> = successEnvelope(
        { id: 42 },
        'req-123'
      );

      expect(envelope.success).toBe(true);
      expect(envelope.data.id).toBe(42);
    });

    it('errorEnvelope is typed correctly', () => {
      const envelope: ErrorEnvelope = errorEnvelope(
        'ERROR',
        'Something went wrong',
        'req-123'
      );

      expect(envelope.success).toBe(false);
      expect(envelope.error.code).toBe('ERROR');
    });
  });
});
