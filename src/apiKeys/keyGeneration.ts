import { createHash, randomBytes } from 'crypto';

const PREFIX_LENGTH = 8;
const KEY_BYTES = 32;

export type GeneratedApiKey = {
  key: string;
  hash: string;
  prefix: string;
};

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateSecureKey(): GeneratedApiKey {
  const key = randomBytes(KEY_BYTES).toString('base64url');

  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, PREFIX_LENGTH)
  };
}