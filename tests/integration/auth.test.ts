/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createTestDb } from '../helpers/db.js';
import { TEST_JWT_SECRET, signTokenMissingClaims } from '../helpers/jwt.js';
import { requireAuth } from '../../src/middleware/requireAuth.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

const mockVerifySignature = jest.fn();

function buildAuthApp(pool: any) {
  const app = express();
  app.use(express.json());

  app.post('/auth/wallet', async (req, res) => {
    const { walletAddress, signature, message } = req.body;

    if (!walletAddress || !signature || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isValid = await mockVerifySignature(walletAddress, signature, message);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const result = await pool.query(
      `INSERT INTO users (wallet_address)
       VALUES ($1)
       ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
       RETURNING id, wallet_address`,
      [walletAddress]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, walletAddress: user.wallet_address },
      TEST_JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({ token, user });
  });

  app.get('/protected', requireAuth, (req, res) => {
    res.status(200).json({ message: 'Success', user: res.locals.authenticatedUser });
  });

  app.use(errorHandler);

  return app;
}

describe('POST /auth/wallet', () => {
  let db: any;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = buildAuthApp(db.pool);
    mockVerifySignature.mockReset();
  });

  afterEach(async () => {
    await db.end();
  });

  it('returns 200 and JWT when signature is valid', async () => {
    mockVerifySignature.mockResolvedValue(true);

    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: 'GDTEST123STELLAR', signature: 'mock-sig', message: 'Login to Callora' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.wallet_address).toBe('GDTEST123STELLAR');

    const decoded = jwt.verify(res.body.token, TEST_JWT_SECRET) as any;
    expect(decoded.walletAddress).toBe('GDTEST123STELLAR');
  });

  it('returns 401 when signature is invalid', async () => {
    mockVerifySignature.mockResolvedValue(false);

    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: 'GDTEST123STELLAR', signature: 'bad-sig', message: 'Login to Callora' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/auth/wallet')
      .send({ walletAddress: 'GDTEST123STELLAR' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns same user on second login with same wallet', async () => {
    mockVerifySignature.mockResolvedValue(true);
    const payload = { walletAddress: 'GDTEST123STELLAR', signature: 'mock-sig', message: 'Login to Callora' };

    const res1 = await request(app).post('/auth/wallet').send(payload);
    const res2 = await request(app).post('/auth/wallet').send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.user.id).toBe(res2.body.user.id);
  });
});

describe('requireAuth middleware integration', () => {
  let db: any;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = buildAuthApp(db.pool);
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(async () => {
    await db.end();
  });

  it('rejects token with missing both userId and sub', async () => {
    const token = signTokenMissingClaims({ foo: 'bar' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
  });

  it('rejects token with empty userId', async () => {
    const token = signTokenMissingClaims({ userId: '' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
  });

  it('rejects token with empty sub', async () => {
    const token = signTokenMissingClaims({ sub: '' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_CLAIMS');
  });

  it('accepts token with userId', async () => {
    const token = signTokenMissingClaims({ userId: 'user-123' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('user-123');
  });

  it('accepts token with sub (subject) as fallback', async () => {
    const token = signTokenMissingClaims({ sub: 'user-456' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('user-456');
  });
});
