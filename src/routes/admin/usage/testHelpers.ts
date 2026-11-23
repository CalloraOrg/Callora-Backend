import jwt from 'jsonwebtoken';
import type { Response } from 'supertest';

declare const expect: (actual: unknown) => {
  toBe(expected: unknown): void;
  toBeDefined(): void;
  toContain(expected: string): void;
};

export const TEST_ADMIN_API_KEY = 'test-admin-api-key';
export const TEST_JWT_SECRET = 'test-admin-jwt-secret-for-usage-routes';

export interface SavedAuthEnv {
  ADMIN_API_KEY: string | undefined;
  JWT_SECRET: string | undefined;
}

export function setupAdminAuthEnv(): SavedAuthEnv {
  const saved: SavedAuthEnv = {
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  return saved;
}

export function restoreAdminAuthEnv(saved: SavedAuthEnv): void {
  if (saved.ADMIN_API_KEY === undefined) {
    delete process.env.ADMIN_API_KEY;
  } else {
    process.env.ADMIN_API_KEY = saved.ADMIN_API_KEY;
  }

  if (saved.JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = saved.JWT_SECRET;
  }
}

export function adminHeaders(): Record<string, string> {
  return { 'x-admin-api-key': TEST_ADMIN_API_KEY };
}

export function nonAdminHeaders(): Record<string, string> {
  const token = jwt.sign(
    { sub: 'developer-1', role: 'developer' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
  return { Authorization: `Bearer ${token}` };
}

export function expectErrorEnvelope(
  res: Response,
  status: number,
  code: string,
  messagePart?: string,
): void {
  expect(res.status).toBe(status);
  expect(res.body.success).toBe(false);
  expect(res.body.error).toBeDefined();
  expect(res.body.error.code).toBe(code);
  if (messagePart !== undefined) {
    expect(res.body.error.message).toContain(messagePart);
  }
}

export function expectValidationError(
  res: Response,
  field: string,
  messagePart?: string,
): void {
  expectErrorEnvelope(res, 400, 'VALIDATION_ERROR', 'Request validation failed');
  expect(Array.isArray(res.body.error.details)).toBe(true);
  const match = (res.body.error.details as Array<{ field: string; message: string }>).find(
    (d) => d.field === field,
  );
  expect(match).toBeDefined();
  if (messagePart !== undefined && match) {
    expect(match.message).toContain(messagePart);
  }
}
