import { describe, expect, it } from '@jest/globals';
import {
  boundedRetryAfterMs,
  isPublicErrorCode,
  normalizeError,
  normalizePublicCode,
  publicCodeForStatus,
  safePublicMessage,
  safeValidationDetails,
} from './errorEnvelopePolicy.js';

describe('error envelope policy', () => {
  it('maps all supported HTTP statuses to stable public codes', () => {
    const expected: Array<[number, string]> = [
      [400, 'BAD_REQUEST'], [401, 'UNAUTHORIZED'], [402, 'PAYMENT_REQUIRED'],
      [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [408, 'REQUEST_TIMEOUT'],
      [409, 'CONFLICT'], [413, 'REQUEST_BODY_TOO_LARGE'], [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [422, 'UNPROCESSABLE_ENTITY'], [429, 'TOO_MANY_REQUESTS'], [500, 'INTERNAL_SERVER_ERROR'],
      [502, 'BAD_GATEWAY'], [503, 'SERVICE_UNAVAILABLE'], [504, 'GATEWAY_TIMEOUT'],
    ];
    for (const [status, code] of expected) expect(publicCodeForStatus(status)).toBe(code);
  });

  it('uses safe fallback codes for unknown statuses and invalid supplied codes', () => {
    expect(publicCodeForStatus(501)).toBe('INTERNAL_SERVER_ERROR');
    expect(publicCodeForStatus(418)).toBe('BAD_REQUEST');
    expect(normalizePublicCode('NOT_A_PUBLIC_CODE', 502)).toBe('BAD_GATEWAY');
    expect(normalizePublicCode('CONFLICT', 500)).toBe('CONFLICT');
    expect(isPublicErrorCode('NOT_FOUND')).toBe(true);
    expect(isPublicErrorCode('database_error')).toBe(false);
  });

  it('preserves trusted application messages', () => {
    expect(safePublicMessage('Wallet is suspended', 403, true)).toBe('Wallet is suspended');
    expect(safePublicMessage('', 403, true)).toBe('Request failed');
    expect(safePublicMessage('body too large', 413, true)).toBe('Request body too large');
  });

  it('hides unknown production failures and sensitive development messages', () => {
    expect(safePublicMessage('database password=secret', 500, false, true)).toBe('Internal server error');
    expect(safePublicMessage('connection string postgres://...', 502, false, true)).toBe('Internal server error');
    expect(safePublicMessage('upstream unavailable', 502, false, false)).toBe('Internal server error');
    expect(safePublicMessage('bad input', 400, false, true)).toBe('bad input');
  });

  it('normalizes and bounds validation details', () => {
    expect(safeValidationDetails([
      { field: 'body.email', message: 'Invalid email', code: 'INVALID_FORMAT' },
      { field: 4, message: 'ignored', code: 'BAD' },
      null,
    ])).toEqual([{ field: 'body.email', message: 'Invalid email', code: 'INVALID_FORMAT' }]);
    expect(safeValidationDetails([])).toBeUndefined();
    expect(safeValidationDetails('not-details')).toBeUndefined();
    expect(safeValidationDetails([{ field: 'x', message: 'y' }])).toBeUndefined();
  });

  it('bounds untrusted retry metadata to one day', () => {
    expect(boundedRetryAfterMs(0)).toBe(0);
    expect(boundedRetryAfterMs(12.9)).toBe(12);
    expect(boundedRetryAfterMs(999_999_999)).toBe(86_400_000);
    expect(boundedRetryAfterMs(-1)).toBeUndefined();
    expect(boundedRetryAfterMs(Number.NaN)).toBeUndefined();
    expect(boundedRetryAfterMs('100')).toBeUndefined();
  });

  it('normalizes trusted validation errors into the versioned contract', () => {
    expect(normalizeError({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ field: 'body.amount', message: 'Required', code: 'INVALID_TYPE' }],
      trusted: true,
    })).toEqual({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ field: 'body.amount', message: 'Required', code: 'INVALID_TYPE' }],
    });
  });

  it('normalizes rate-limit metadata without exposing unsupported fields', () => {
    expect(normalizeError({ statusCode: 429, message: 'Too many requests', retryAfterMs: 5_000, trusted: true })).toEqual({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests',
      retryAfterMs: 5_000,
    });
  });

  it('uses generic messages for unknown client errors in production', () => {
    const result = normalizeError({ statusCode: 400, message: 'private internal detail', trusted: false, development: false });
    expect(result).toMatchObject({ code: 'BAD_REQUEST', message: 'Request failed' });
  });

  it('keeps safe developer diagnostics only for non-sensitive client failures', () => {
    expect(normalizeError({ statusCode: 400, message: 'field x is invalid', trusted: false, development: true }).message).toBe('field x is invalid');
    expect(normalizeError({ statusCode: 500, message: 'field x is invalid', trusted: false, development: true }).message).toBe('Internal server error');
  });

  it('truncates oversized validation values', () => {
    const result = safeValidationDetails([{ field: 'f'.repeat(500), message: 'm'.repeat(800), code: 'c'.repeat(200) }]);
    expect(result?.[0].field).toHaveLength(200);
    expect(result?.[0].message).toHaveLength(500);
    expect(result?.[0].code).toHaveLength(100);
  });
});
