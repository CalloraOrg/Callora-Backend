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

/**
 * Build the full set of headers to strip for a given request/response,
 * combining the static hop-by-hop set with any names listed in the
 * `Connection` header value.
 *
 * @param connectionHeaderValue  The raw value of the `Connection` header,
 *   or undefined/null if absent.
 */
export function buildHopByHopSet(connectionHeaderValue?: string | null): Set<string> {
  if (!connectionHeaderValue) return STATIC_HOP_BY_HOP;

  const dynamic = new Set(STATIC_HOP_BY_HOP);
  for (const token of connectionHeaderValue.split(',')) {
    const name = token.trim().toLowerCase();
    if (name) dynamic.add(name);
  }
  return dynamic;
}

/**
 * Return a new headers object with all hop-by-hop headers removed.
 *
 * @param headers  Plain object of header name → string value pairs.
 */
export function stripHopByHopHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const connectionValue = headers['connection'] ?? headers['Connection'];
  const stripSet = buildHopByHopSet(connectionValue);

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!stripSet.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
