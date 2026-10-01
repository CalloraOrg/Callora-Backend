import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string equality (#1266).
 *
 * Both inputs are reduced to fixed-length SHA-256 digests before being
 * compared with `crypto.timingSafeEqual`, so the comparison time depends
 * neither on where the strings first differ (no prefix oracle) nor on their
 * lengths (a naive `length !== length` early exit leaks the secret's length).
 *
 * Shared helper for secret comparisons such as the metrics bearer token;
 * callers should prefer it over hand-rolled `===` / `!==` checks.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Extracts the credential from an `Authorization: Bearer <token>` header.
 *
 * The scheme is matched case-insensitively (RFC 7235 §2.1). Returns `null`
 * when the header is missing, uses another scheme, or carries an empty
 * token, so callers can treat every malformed header as "no credentials".
 */
export function parseBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match?.[1] ?? null;
}
