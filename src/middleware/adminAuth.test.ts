import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { adminAuth } from './adminAuth.js';

const TEST_API_KEY = 'test-admin-api-key';
const TEST_JWT_SECRET = 'test-jwt-secret';

function makeReq(headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('adminAuth middleware — unit', () => {
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_API_KEY;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    next = jest.fn();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
  });

  // ── API key path ────────────────────────────────────────────────────────────

  describe('x-admin-api-key header', () => {
    it('calls next() when the key matches ADMIN_API_KEY', () => {
      const res = makeRes();
      adminAuth(makeReq({ 'x-admin-api-key': TEST_API_KEY }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 401 when the key does not match', () => {
      const res = makeRes();
      adminAuth(makeReq({ 'x-admin-api-key': 'wrong-key' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: admin access required' });
    });

    it('returns 401 when ADMIN_API_KEY env var is unset and a key header is provided', () => {
      delete process.env.ADMIN_API_KEY;
      const res = makeRes();
      adminAuth(makeReq({ 'x-admin-api-key': 'any-key' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('skips the API key branch and falls through to 401 when header is an empty string', () => {
      const res = makeRes();
      adminAuth(makeReq({ 'x-admin-api-key': '' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // ── Bearer JWT path ─────────────────────────────────────────────────────────

  describe('Bearer JWT', () => {
    it('calls next() for a valid admin JWT', () => {
      const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 401 when the JWT has a non-admin role', () => {
      const token = jwt.sign({ role: 'developer', sub: 'user-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when the JWT has no role claim', () => {
      const token = jwt.sign({ sub: 'user-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 for an expired JWT', () => {
      const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, TEST_JWT_SECRET, { expiresIn: '-1s' });
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when the JWT is signed with the wrong secret', () => {
      const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, 'wrong-secret', { expiresIn: '1h' });
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when the Bearer value is not a valid JWT', () => {
      const res = makeRes();
      adminAuth(makeReq({ authorization: 'Bearer not-a-real-jwt' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 for the alg:none attack (unsigned token claiming admin role)', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({ role: 'admin', sub: 'admin-1', iat: Math.floor(Date.now() / 1000) }),
      ).toString('base64url');
      const token = `${header}.${body}.`;
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Bearer ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when the Authorization header does not use the Bearer scheme', () => {
      const token = jwt.sign({ role: 'admin', sub: 'admin-1' }, TEST_JWT_SECRET, { expiresIn: '1h' });
      const res = makeRes();
      adminAuth(makeReq({ authorization: `Token ${token}` }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 500 when JWT_SECRET is not configured', () => {
      delete process.env.JWT_SECRET;
      const res = makeRes();
      adminAuth(makeReq({ authorization: 'Bearer some-token' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'JWT_SECRET not configured' });
    });
  });

  // ── No credentials ──────────────────────────────────────────────────────────

  describe('no credentials', () => {
    it('returns 401 when no credentials are provided', () => {
      const res = makeRes();
      adminAuth(makeReq({}), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: admin access required' });
    });
  });

  // ── Priority: API key wins over JWT ────────────────────────────────────────

  describe('credential priority', () => {
    it('passes with a valid API key even when the Bearer token is invalid', () => {
      const res = makeRes();
      adminAuth(
        makeReq({ 'x-admin-api-key': TEST_API_KEY, authorization: 'Bearer bad-jwt' }),
        res,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 401 when both the API key and the Bearer token are invalid', () => {
      const res = makeRes();
      adminAuth(
        makeReq({ 'x-admin-api-key': 'wrong-key', authorization: 'Bearer bad-jwt' }),
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
