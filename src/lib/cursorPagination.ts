/**
 * Cursor pagination helpers for stable keyset pagination.
 *
 * A cursor encodes `{ timestamp: Date, id: string }` as a base64-encoded JSON
 * string so it is opaque to API consumers.
 *
 * Example encoded cursor (before base64):
 *   {"timestamp":"2026-03-01T09:30:00.000Z","id":"42"}
 */

export interface CursorPayload {
  timestamp: Date;
  id: string;
}

/**
 * Encodes a (timestamp, id) pair into an opaque base64url cursor string.
 */
export function encodeCursor(timestamp: Date, id: string): string {
  const json = JSON.stringify({
    timestamp: timestamp.toISOString(),
    id,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

const BASE64_OR_BASE64URL_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeBase64Flexible(input: string): string | null {
  if (!input || input.length % 4 === 1 || !BASE64_OR_BASE64URL_RE.test(input)) {
    return null;
  }
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Decodes a base64url (or legacy standard base64) cursor string back to `{ timestamp, id }`.
 * Returns `null` when the cursor is missing, malformed, or contains
 * an invalid timestamp so callers can surface a 400 error.
 */
export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = decodeBase64Flexible(cursor);
    if (json === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(json);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).timestamp !== 'string' ||
      typeof (parsed as Record<string, unknown>).id !== 'string' ||
      (parsed as Record<string, unknown>).id === ''
    ) {
      return null;
    }

    const { timestamp, id } = parsed as { timestamp: string; id: string };
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return { timestamp: date, id };
  } catch {
    return null;
  }
}

/**
 * Parses an unknown query-param value as a cursor.
 * Returns the decoded cursor when the value is a valid non-empty string,
 * or `null` if the value is absent/empty/invalid.
 */
export function parseCursor(value: unknown): CursorPayload | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return decodeCursor(value.trim());
}
