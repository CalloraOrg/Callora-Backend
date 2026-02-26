import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDb } from '../helpers/db.js';
import { signTestToken, signExpiredToken, TEST_JWT_SECRET } from '../helpers/jwt.js';

interface JwtClaims {
  userId: string;
  walletAddress: string;
}

interface RequestWithUser extends Request {
  user?: JwtClaims;
}

interface UsageRow {
  calls: string;
}

interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: UsageRow[] }>;
}

type TestDb = ReturnType<typeof createTestDb>;

function buildProtectedApp(pool: Queryable) {
  const app = express();
  app.use(express.json());

  const jwtGuard = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, TEST_JWT_SECRET) as JwtClaims;
      (req as RequestWithUser).user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };

  app.get('/api/usage', jwtGuard, async (req: Request, res: Response) => {
    const authenticatedUser = (req as RequestWithUser).user;
    if (!authenticatedUser) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const result = await pool.query(
      `SELECT COUNT(*) as calls FROM usage_logs
       WHERE api_key_id IN (
         SELECT id FROM api_keys WHERE user_id = $1
       )`,
      [authenticatedUser.userId]
    );
    return res.status(200).json({
      calls: parseInt(result.rows[0].calls),
      period: 'current',
      wallet: authenticatedUser.walletAddress,
    });
  });

  return app;
}

describe('GET /api/usage - JWT protected', () => {
  let db: TestDb;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = buildProtectedApp(db.pool);
  });

  afterEach(async () => {
    await db.end();
  });

  it('returns 200 with usage data when JWT is valid', async () => {
    const token = signTestToken({
      userId: '00000000-0000-0000-0000-000000000001',
      walletAddress: 'GDTEST123STELLAR',
    });

    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.calls).toBe(0);
    expect(res.body.period).toBe('current');
    expect(res.body.wallet).toBe('GDTEST123STELLAR');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/usage');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  it('returns 401 when token is expired', async () => {
    const token = signExpiredToken({
      userId: '00000000-0000-0000-0000-000000000001',
      walletAddress: 'GDTEST123STELLAR',
    });

    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('returns 401 when token is malformed', async () => {
    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('returns 401 when Authorization header format is wrong', async () => {
    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Token sometoken');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });
});
