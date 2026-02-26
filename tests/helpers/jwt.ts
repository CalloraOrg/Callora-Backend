import jwt from 'jsonwebtoken';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-prod';

export function signTestToken(payload: { userId: string; walletAddress: string }) {
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

export function signExpiredToken(payload: { userId: string; walletAddress: string }) {
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '-1s' });
}
