/**
 * Focused tests for auth request validation.
 *
 * Coverage:
 *  1. Unit tests for walletLoginSchema and refreshTokenSchema (Zod layer)
 *  2. Integration tests verifying that bodyValidator produces structured
 *     HTTP 400 responses with the expected error envelope shape when the
 *     auth routes receive invalid payloads.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { bodyValidator } from '../../src/middleware/validate.js';
import { walletLoginSchema, refreshTokenSchema } from '../../src/validators/auth.js';
import { createAuthRoutes } from '../../src/routes/authRoutes.js';
import { AuthController } from '../../src/controllers/authController.js';
import { RefreshTokenService } from '../../src/services/refreshTokenService.js';
import { TEST_JWT_SECRET } from '../helpers/jwt.js';

// ---------------------------------------------------------------------------
// Minimal mock repository — we only need it to satisfy the AuthController
// constructor; no real DB calls are needed for validation tests.
// ---------------------------------------------------------------------------
class NoopRefreshTokenRepository {
  async createRefreshToken(token: any) { return token; }
  async findRefreshTokenById() { return null; }
  async findRefreshTokenByHash() { return null; }
  async updateLastUsed() { /* noop */ }
  async revokeRefreshToken() { /* noop */ }
  async revokeFamily() { /* noop */ }
  async revokeAllUserTokens() { /* noop */ }
  async cleanupExpiredTokens() { return 0; }
  async countActiveTokens() { return 0; }
  async listRefreshTokens() { return { tokens: [], hasMore: false }; }
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const refreshTokenService = new RefreshTokenService({
    jwtSecret: TEST_JWT_SECRET,
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  });

  const authController = new AuthController({
    refreshTokenService,
    refreshTokenRepository: new NoopRefreshTokenRepository() as any,
  });

  app.use('/auth', createAuthRoutes(authController));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// 1. Unit tests for walletLoginSchema
// ---------------------------------------------------------------------------
describe('walletLoginSchema', () => {
  it('accepts a valid payload', () => {
    const result = walletLoginSchema.safeParse({
      walletAddress: 'GDTEST123STELLAR',
      signature: 'abc123sig',
      message: 'Login to Callora',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when walletAddress is missing', () => {
    const result = walletLoginSchema.safeParse({
      signature: 'abc123sig',
      message: 'Login to Callora',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('walletAddress');
    }
  });

  it('rejects when walletAddress is an empty string', () => {
    const result = walletLoginSchema.safeParse({
      walletAddress: '',
      signature: 'abc123sig',
      message: 'Login to Callora',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when signature is missing', () => {
    const result = walletLoginSchema.safeParse({
      walletAddress: 'GDTEST123',
      message: 'Login to Callora',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('signature');
    }
  });

  it('rejects when message is missing', () => {
    const result = walletLoginSchema.safeParse({
      walletAddress: 'GDTEST123',
      signature: 'abc123sig',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('message');
    }
  });

  it('rejects an empty object', () => {
    const result = walletLoginSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects non-string walletAddress', () => {
    const result = walletLoginSchema.safeParse({
      walletAddress: 12345,
      signature: 'sig',
      message: 'msg',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Unit tests for refreshTokenSchema
// ---------------------------------------------------------------------------
describe('refreshTokenSchema', () => {
  it('accepts a valid payload', () => {
    const result = refreshTokenSchema.safeParse({ refreshToken: 'some-opaque-token' });
    expect(result.success).toBe(true);
  });

  it('rejects when refreshToken is missing', () => {
    const result = refreshTokenSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('refreshToken');
    }
  });

  it('rejects when refreshToken is an empty string', () => {
    const result = refreshTokenSchema.safeParse({ refreshToken: '' });
    expect(result.success).toBe(false);
  });

  it('rejects when refreshToken is not a string', () => {
    const result = refreshTokenSchema.safeParse({ refreshToken: 42 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Direct bodyValidator unit tests — validates the middleware response shape
// ---------------------------------------------------------------------------
describe('bodyValidator middleware — auth schemas', () => {
  function buildMiddlewareApp(schema: typeof walletLoginSchema | typeof refreshTokenSchema) {
    const app = express();
    app.use(express.json());
    app.post('/test', bodyValidator(schema), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  }

  describe('walletLoginSchema via bodyValidator', () => {
    let app: express.Express;
    beforeEach(() => { app = buildMiddlewareApp(walletLoginSchema); });

    it('passes through a valid body', async () => {
      const res = await request(app).post('/test').send({
        walletAddress: 'GDTEST123',
        signature: 'sig',
        message: 'msg',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 400 with VALIDATION_ERROR code for a missing field', async () => {
      const res = await request(app).post('/test').send({
        walletAddress: 'GDTEST123',
        // signature missing
        message: 'msg',
      });
      expect(res.status).toBe(400);
      // errorHandler wraps in error envelope
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('includes field-level details for missing walletAddress', async () => {
      const res = await request(app).post('/test').send({
        signature: 'sig',
        message: 'msg',
      });
      expect(res.status).toBe(400);
      const details = res.body.error?.details ?? [];
      const walletField = details.find((d: any) => d.field?.includes('walletAddress'));
      expect(walletField).toBeDefined();
    });

    it('returns 400 for an empty body', async () => {
      const res = await request(app).post('/test').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('refreshTokenSchema via bodyValidator', () => {
    let app: express.Express;
    beforeEach(() => { app = buildMiddlewareApp(refreshTokenSchema); });

    it('passes through a valid body', async () => {
      const res = await request(app).post('/test').send({ refreshToken: 'tok' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 400 with VALIDATION_ERROR code when refreshToken is absent', async () => {
      const res = await request(app).post('/test').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('includes field-level details for missing refreshToken', async () => {
      const res = await request(app).post('/test').send({});
      const details = res.body.error?.details ?? [];
      const tokenField = details.find((d: any) => d.field?.includes('refreshToken'));
      expect(tokenField).toBeDefined();
      expect(tokenField.message).toMatch(/required/i);
    });

    it('returns 400 when refreshToken is an empty string', async () => {
      const res = await request(app).post('/test').send({ refreshToken: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end validation on the real auth router
// ---------------------------------------------------------------------------
describe('POST /auth/wallet — Zod validation (integration)', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 with structured error when all fields are missing', async () => {
    const res = await request(app).post('/auth/wallet').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Request validation failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('returns 400 when walletAddress is missing', async () => {
    const res = await request(app)
      .post('/auth/wallet')
      .send({ signature: 'sig', message: 'msg' });
    expect(res.status).toBe(400);
    const details = res.body.error?.details ?? [];
    const walletErr = details.find((d: any) => d.field?.includes('walletAddress'));
    expect(walletErr).toBeDefined();
    expect(walletErr.message).toBe('Wallet address is required');
  });

  it('returns 400 when signature is missing', async () => {
    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: 'GDTEST', message: 'msg' });
    expect(res.status).toBe(400);
    const details = res.body.error?.details ?? [];
    expect(details.find((d: any) => d.field?.includes('signature'))).toBeDefined();
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: 'GDTEST', signature: 'sig' });
    expect(res.status).toBe(400);
    const details = res.body.error?.details ?? [];
    expect(details.find((d: any) => d.field?.includes('message'))).toBeDefined();
  });

  it('returns 400 when walletAddress is an empty string', async () => {
    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: '', signature: 'sig', message: 'msg' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns requestId and timestamp in the error envelope', async () => {
    const res = await request(app).post('/auth/wallet').send({});
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it('passes Zod validation and reaches the controller (which returns 401 for unimplemented login)', async () => {
    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: 'GDTEST', signature: 'sig', message: 'Login to Callora' });
    // Validation passes → controller rejects with AUTH_NOT_IMPLEMENTED
    expect(res.status).toBe(401);
    expect(res.body.error?.code ?? res.body.code).toMatch(/AUTH_NOT_IMPLEMENTED|UNAUTHORIZED/);
  });
});

describe('POST /auth/refresh — Zod validation (integration)', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 with structured error when refreshToken is missing', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Request validation failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('includes field-level detail pointing at body.refreshToken', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    const details: any[] = res.body.error?.details ?? [];
    const tokenErr = details.find((d) => d.field?.includes('refreshToken'));
    expect(tokenErr).toBeDefined();
    expect(tokenErr.message).toBe('Refresh token is required');
  });

  it('returns 400 when refreshToken is an empty string', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('passes validation and reaches the controller when refreshToken is present', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'some-token-value' });
    // Validation passes → controller returns 401 (invalid/unknown token)
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/revoke — Zod validation (integration)', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 with structured error when refreshToken is missing', async () => {
    const res = await request(app).post('/auth/revoke').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('includes field-level detail for missing refreshToken', async () => {
    const res = await request(app).post('/auth/revoke').send({});
    const details: any[] = res.body.error?.details ?? [];
    expect(details.find((d) => d.field?.includes('refreshToken'))).toBeDefined();
  });

  it('passes validation with a non-empty refreshToken', async () => {
    const res = await request(app)
      .post('/auth/revoke')
      .send({ refreshToken: 'some-token-value' });
    // Controller returns 200 (token not found — still success to prevent enumeration)
    expect(res.status).toBe(200);
  });
});
