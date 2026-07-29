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
 * Encodes a (timestamp, id) pair into an opaque base64 cursor string.
 */
export function encodeCursor(timestamp: Date, id: string): string {
  const json = JSON.stringify({
    timestamp: timestamp.toISOString(),
    id,
  });
  return Buffer.from(json, 'utf8').toString('base64');
}

/**
 * Decodes a base64 cursor string back to `{ timestamp, id }`.
 * Returns `null` when the cursor is missing, malformed, or contains
 * an invalid timestamp so callers can surface a 400 error.
 */
export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).timestamp !== 'string' ||
      typeof (parsed as Record<string, unknown>).id !== 'string'
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
