/**
 * @file src/middleware/etagCache.ts
 * @description Strong ETag / 304 Not Modified support for GET /api/apis routes.
 *
 * ── Why strong, not weak? ────────────────────────────────────────────────────
 * Express's default ETag mode generates *weak* ETags ("W/...") using a
 * combination of the response body length and a timestamp from res.getHeader.
 * Weak ETags signal that two representations are semantically equivalent but
 * not byte-for-byte identical — they are unsuitable for byte-range requests.
 * More importantly, weak ETags are computed from length + time, so two
 * responses with identical bodies but different timestamps get different ETags,
 * defeating caching for repeat reads within the same second.
 *
 * Strong ETags are derived from a SHA-256 digest of the actual serialized body,
 * so they change if and only if the response content changes. This is the
 * correct semantics for an API that returns a deterministic JSON response.
 *
 * Express's built-in ETag generation is NOT disabled globally — doing so would
 * affect all other routes. Instead, this middleware sets the ETag header
 * explicitly before `res.json()` sends the response, which causes Express to
 * skip its own ETag generation for that response (Express only generates an
 * ETag if the ETag header is not already set by the time the response is
 * finalized).
 *
 * ── Approach: compute-then-compare ──────────────────────────────────────────
 * The route already uses an in-process ListingsCache that skips the DB on
 * cache hits, so the most expensive work (DB query + pagination formatting) is
 * already avoided on cache hits. The ETag is computed from the serialized JSON
 * body after the response object is ready but before it is sent over the wire.
 *
 * Skipping serialization on 304 responses would require restructuring the route
 * handler to build the response object in a separate step, which would touch
 * unrelated logic and increase complexity. The current approach:
 *   1. Build the response object normally (cache hit avoids the DB).
 *   2. Serialize it to JSON and compute a SHA-256 digest.
 *   3. If the digest matches If-None-Match, respond 304 with no body.
 *   4. Otherwise, set ETag header and send the JSON body.
 *
 * The cost of JSON.stringify + SHA-256 on a typical paginated API listing
 * (~20 items) is sub-millisecond and is negligible compared to any network RTT.
 *
 * ── If-None-Match parsing ────────────────────────────────────────────────────
 * Per RFC 9110 §13.1.2, If-None-Match may contain:
 *   - A comma-separated list of ETags, each optionally quoted: "abc", "def"
 *   - A wildcard: *
 *   - Weak ETags prefixed with W/: W/"abc"
 *
 * This implementation normalises incoming ETags to their unquoted digest value
 * before comparison. Weak ETags from If-None-Match are accepted and compared
 * against the strong ETag value (per RFC 9110 §13.1.2 the weak comparison
 * function is used for If-None-Match).
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 * SHA-256 digests do not leak information about the content structure beyond
 * what the response body itself would reveal. The ETag is truncated to the
 * first 32 hex characters (128 bits) — sufficient for collision resistance in
 * this context while keeping headers compact.
 */

import { createHash } from 'node:crypto';

/**
 * Compute a strong ETag value for an arbitrary serialisable payload.
 *
 * The value is the first 32 hex chars of the SHA-256 digest of the
 * JSON-serialized body, wrapped in double-quotes as required by RFC 9110.
 *
 * @example
 * computeStrongETag({ data: [], meta: { total: 0, limit: 20, offset: 0 } })
 * // => '"a7ffc6f8bf1ed76651c14756a061d662"'  (illustrative, not real)
 */
export function computeStrongETag(body: unknown): string {
  const json = JSON.stringify(body);
  const digest = createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 32);
  return `"${digest}"`;
}

/**
 * Parse an If-None-Match header value into a set of normalised ETag strings.
 *
 * Handles:
 *   - Wildcard:  "*"
 *   - List:      `"abc", "def"`, `W/"abc", "def"`
 *   - Malformed: returns an empty set so the caller falls back to a 200
 *
 * Each tag in the returned set is the bare digest string without quotes or
 * the W/ prefix, allowing a single `Set.has(digest)` lookup.
 *
 * @returns A Set of normalised tag strings, or the singleton Set(['*']) for
 *          the wildcard case.
 */
export function parseIfNoneMatch(headerValue: string | undefined): Set<string> {
  if (!headerValue) {
    return new Set();
  }

  const trimmed = headerValue.trim();

  // Wildcard — matches any ETag
  if (trimmed === '*') {
    return new Set(['*']);
  }

  const tags = new Set<string>();

  // Split on commas, then strip quotes and the optional W/ prefix
  for (const part of trimmed.split(',')) {
    const raw = part.trim();
    if (!raw) continue;

    // Strip optional weak prefix: W/"..." or w/"..."
    const withoutWeak = raw.replace(/^W\//i, '');

    // Strip surrounding double-quotes
    const unquoted = withoutWeak.replace(/^"(.*)"$/, '$1');

    if (unquoted) {
      tags.add(unquoted);
    }
  }

  return tags;
}

/**
 * Determine whether a computed ETag matches the client's If-None-Match header.
 *
 * `currentETag` must be the quoted form returned by `computeStrongETag`,
 * e.g. `'"abc123"'`.
 *
 * Matching rules (RFC 9110 §13.1.2 weak comparison for If-None-Match):
 *   - Wildcard "*" always matches.
 *   - Otherwise the bare digest of `currentETag` is compared against every
 *     tag extracted from `ifNoneMatchHeader`.
 */
export function isETagMatch(currentETag: string, ifNoneMatchHeader: string | undefined): boolean {
  const tags = parseIfNoneMatch(ifNoneMatchHeader);

  if (tags.size === 0) {
    return false;
  }

  if (tags.has('*')) {
    return true;
  }

  // Strip quotes from the current strong ETag to get the bare digest
  const currentDigest = currentETag.replace(/^"(.*)"$/, '$1');
  return tags.has(currentDigest);
}
