/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../src/middleware/requireAuth.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import {
  TEST_JWT_SECRET,
  signTestToken,
  signExpiredToken,
  signTokenWrongSecret,
  signTokenWithAlgorithm,
  signTokenMissingClaims,
  buildNoneAlgorithmToken,
} from '../helpers/jwt.js';

const VALID_PAYLOAD = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  walletAddress: 'GDTEST123STELLAR',
};

/**
 * Minimal Express app that gates a single endpoint behind requireAuth
 * and returns the authenticated user id on success.
 */
function buildTestApp() {
  const app = express();
  app.use(express.json());

  app.get(
    '/protected',
    requireAuth,
    (_req: express.Request, res: express.Response<unknown, AuthenticatedLocals>) => {
      res.json({ userId: res.locals.authenticatedUser?.id });
    },
  );

  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let app: express.Express;
const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  app = buildTestApp();
});

afterEach(() => {
  if (originalSecret !== undefined) {
    process.env.JWT_SECRET = originalSecret;
  } else {
    delete process.env.JWT_SECRET;
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('requireAuth – happy path', () => {
  it('passes through with a valid Bearer JWT and sets authenticatedUser', async () => {
    const token = signTestToken(VALID_PAYLOAD);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(VALID_PAYLOAD.userId);
  });

  it('accepts x-user-id header when no Bearer token is present', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-user-id', 'user-via-header');

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-via-header');
  });
});

// ---------------------------------------------------------------------------
// Missing credentials
// ---------------------------------------------------------------------------

describe('requireAuth – missing credentials', () => {
  it('returns 401 when no Authorization or x-user-id header is sent', async () => {
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when Authorization header is present but not Bearer scheme', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_HEADER');
  });

  it('returns 401 when invalid Authorization header is present alongside x-user-id', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .set('x-user-id', 'user-via-header');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_HEADER');
  });

  it('returns 401 when Bearer prefix is malformed and no token is provided', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_HEADER');
  });

  it('returns 401 when malformed Bearer authorization is present alongside x-user-id', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer')
      .set('x-user-id', 'user-via-header');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_HEADER');
  });

  it('returns 401 with MISSING_TOKEN for Bearer followed by only whitespace', async () => {
    // Use a tab character that survives transport to trigger the empty-token guard
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer \t');

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Expired tokens
// ---------------------------------------------------------------------------

describe('requireAuth – expired tokens', () => {
  it('returns 401 with TOKEN_EXPIRED code for an expired JWT', async () => {
    const token = signExpiredToken(VALID_PAYLOAD);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token expired');
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// Malformed tokens
// ---------------------------------------------------------------------------

describe('requireAuth – malformed tokens', () => {
  it('rejects a completely invalid string', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer not-a-jwt');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token with only two dot-separated segments and garbage', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer aaa.bbb.ccc');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token with valid base64 header but corrupted payload', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${header}.!!!invalid!!!.fakesig`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('does not leak token content in the error response', async () => {
    const sensitiveToken = 'eyJhbGciOiJIUzI1NiJ9.SENSITIVE_DATA.badsig';
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${sensitiveToken}`);

    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SENSITIVE_DATA');
  });
});

// ---------------------------------------------------------------------------
// Wrong algorithm
// ---------------------------------------------------------------------------

describe('requireAuth – algorithm restrictions', () => {
  it('rejects a token signed with HS384 when only HS256 is allowed', async () => {
    const token = signTokenWithAlgorithm(VALID_PAYLOAD, 'HS384');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token signed with HS512 when only HS256 is allowed', async () => {
    const token = signTokenWithAlgorithm(VALID_PAYLOAD, 'HS512');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('rejects a crafted "alg: none" token', async () => {
    const token = buildNoneAlgorithmToken(VALID_PAYLOAD);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Wrong secret
// ---------------------------------------------------------------------------

describe('requireAuth – wrong signing secret', () => {
  it('rejects a token signed with an incorrect secret', async () => {
    const token = signTokenWrongSecret(VALID_PAYLOAD);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Missing claims
// ---------------------------------------------------------------------------

describe('requireAuth – missing or invalid claims', () => {
  it('rejects a token that has no userId claim', async () => {
    const token = signTokenMissingClaims({ walletAddress: 'GDTEST123STELLAR' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
    expect(res.body.error).toMatch(/missing required claims/i);
  });

  it('rejects a token where userId is an empty string', async () => {
    const token = signTokenMissingClaims({ userId: '', walletAddress: 'GDTEST123STELLAR' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
  });

  it('rejects a token where userId is a number instead of a string', async () => {
    const token = signTokenMissingClaims({ userId: 12345, walletAddress: 'GDTEST123STELLAR' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
  });

  it('rejects a token with only standard JWT claims and no userId', async () => {
    const token = signTokenMissingClaims({ sub: 'some-subject', iss: 'callora' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
  });
});

// ---------------------------------------------------------------------------
// JWT_SECRET not configured
// ---------------------------------------------------------------------------

describe('requireAuth – server misconfiguration', () => {
  it('returns 401 when JWT_SECRET env var is not set', async () => {
    delete process.env.JWT_SECRET;
    const token = signTestToken(VALID_PAYLOAD);

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
