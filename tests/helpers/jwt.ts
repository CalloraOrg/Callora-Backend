import jwt from 'jsonwebtoken';

import crypto from 'node:crypto';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-prod';
export const TEST_GATEWAY_SECRET = 'test-gateway-secret-for-forwarded-user-id';

export function signTestToken(payload: { userId: string; walletAddress?: string }) {
  const fullPayload = {
    walletAddress: 'GDTEST123STELLAR',
    ...payload,
  };
  return jwt.sign(fullPayload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

export function createTestGatewaySignature(
  userId: string,
  secret: string = TEST_GATEWAY_SECRET,
  timestamp?: string,
): string {
  const data = timestamp ? `${timestamp}.${userId}` : userId;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function signExpiredToken(payload: { userId: string; walletAddress?: string }) {
  const fullPayload = {
    walletAddress: 'GDTEST123STELLAR',
    ...payload,
  };
  return jwt.sign(fullPayload, TEST_JWT_SECRET, { expiresIn: '-1s' });
}

/** Sign a token using a different secret than the one the server expects. */
export function signTokenWrongSecret(payload: { userId: string; walletAddress: string }) {
  return jwt.sign(payload, 'completely-wrong-secret', { expiresIn: '1h' });
}

/** Sign a token with an algorithm the server should reject. */
export function signTokenWithAlgorithm(
  payload: { userId: string; walletAddress: string },
  algorithm: jwt.Algorithm,
) {
  return jwt.sign(payload, TEST_JWT_SECRET, { algorithm, expiresIn: '1h' });
}

/** Sign a token whose payload is missing the required `userId` claim. */
export function signTokenMissingClaims(payload: Record<string, unknown>) {
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Build a token-like string with the `none` algorithm.
 * This simulates the classic "alg: none" attack vector.
 */
export function buildNoneAlgorithmToken(payload: { userId: string; walletAddress: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}
