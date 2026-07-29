/**
 * Hop-by-hop header utilities (RFC 7230 §6.1)
 *
 * Hop-by-hop headers are meaningful only for a single transport-level
 * connection and MUST NOT be forwarded by proxies.  Forwarding them can
 * cause protocol errors, connection-management bugs, or security issues
 * (e.g. leaking Proxy-Authorization credentials to the upstream origin).
 *
 * Two categories are handled:
 *
 *   1. Static set  — the eight headers listed in RFC 7230 §6.1 plus
 *      common de-facto additions (proxy-connection, keep-alive as a
 *      standalone header).
 *
 *   2. Dynamic set — the `Connection` header itself may carry a
 *      comma-separated list of additional header names that the sender
 *      wants treated as hop-by-hop for that specific connection
 *      (RFC 7230 §6.1 ¶1).  These must also be stripped.
 *
 * Security note: all comparisons are lower-cased so mixed-case variants
 * (e.g. "Transfer-Encoding", "KEEP-ALIVE") are caught regardless of how
 * the client or upstream formats them.
 */

/** The static set of hop-by-hop header names (lower-cased). */
export const STATIC_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection', // de-facto; not in RFC but widely used
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers that MUST NOT be treated as hop-by-hop for security reasons (Request Smuggling prevention). */
const PROTECTED_HEADERS = new Set(['host', 'content-length']);

/**
 * Build the full set of headers to strip for a given request/response,
 * combining the static hop-by-hop set with any names listed in the
 * `Connection` header value.
 *
 * @param connectionHeaderValue  The raw value of the `Connection` header,
 *   or undefined/null if absent. Supports string or string array (Node.js standard).
 */
export function buildHopByHopSet(
  connectionHeaderValue?: string | string[] | null,
): Set<string> {
  if (!connectionHeaderValue) return new Set(STATIC_HOP_BY_HOP);

  const dynamic = new Set(STATIC_HOP_BY_HOP);
  const values = Array.isArray(connectionHeaderValue)
    ? connectionHeaderValue
    : [connectionHeaderValue];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      // Prevent stripping of framing headers which could lead to smuggling attacks
      if (name && !PROTECTED_HEADERS.has(name)) {
        dynamic.add(name);
      }
    }
  }
  return dynamic;
}

/**
 * Return a new headers object with all hop-by-hop headers removed.
 *
 * @param headers  Plain object of header name → string value pairs.
 */
export function stripHopByHopHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  // Collect all connection header values case-insensitively to prevent smuggling bypass
  const connectionValues: string[] = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'connection') {
      const val = headers[key];
      if (Array.isArray(val)) {
        connectionValues.push(...val.filter((v): v is string => typeof v === 'string'));
      } else if (typeof val === 'string') {
        connectionValues.push(val);
      }
    }
  }

  // Pass collected values to build the strip set; returns static set if empty
  const stripSet = buildHopByHopSet(
    connectionValues.length > 0 ? connectionValues : undefined,
  );

  const result: Record<string, string | string[] | undefined> = {};
  for (const key of Object.keys(headers)) {
    if (!stripSet.has(key.toLowerCase())) {
      result[key] = headers[key];
    }
  }
  return result;
}
