import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

/**
 * Generates a strong ETag for the given content.
 *
 * Strong ETags are byte-for-byte identical comparisons (RFC 7232 §2.1).
 * We use SHA-256 over the serialised response body so any change in content —
 * including pagination metadata or a single field value — produces a different tag.
 *
 * Format: `"<hex-digest>"`
 */
export function generateETag(content: string | Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `"${hash}"`;
}

/**
 * Compares a client-supplied `If-None-Match` header value against a candidate
 * ETag using **strong comparison** (RFC 7232 §3.2):
 *   - A wildcard `*` always matches.
 *   - Weak ETags (`W/"..."`) on the client side never match a strong server ETag.
 *   - Multiple comma-separated ETags are evaluated left-to-right; the first
 *     strong match short-circuits.
 *
 * Returns `true` when the resource has not changed and a 304 is appropriate.
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();

  // Wildcard – matches everything (RFC 7232 §3.2)
  if (trimmed === '*') return true;

  // Split on commas, strip surrounding whitespace from each token
  const clientTags = trimmed.split(',').map((t) => t.trim());

  for (const tag of clientTags) {
    // Only strong tags can match under strong comparison.
    // Weak tags start with W/ and are excluded.
    if (!tag.startsWith('W/') && tag === etag) return true;
  }

  return false;
}

/**
 * Express middleware that adds strong ETag / 304 Not Modified support to GET
 * and HEAD endpoints.
 *
 * ## How it works
 *
 * 1. Intercepts `res.json()` before the response body is written.
 * 2. For 200 OK responses that do not already carry an ETag, computes a
 *    SHA-256 digest of the serialised JSON body and sets it as a strong
 *    `ETag` response header.
 * 3. Evaluates the `If-None-Match` request header using **strong comparison**
 *    (RFC 7232 §3.2).  If the tags match, the response status is set to 304
 *    and `res.end()` is called directly so the body is omitted.
 * 4. When our strong comparison determines there is **no match**, the
 *    `If-None-Match` header is cleared from the request before delegating to
 *    the original `res.json()`.  This prevents Express's built-in `fresh`
 *    module — which uses **weak** comparison and would incorrectly return 304
 *    when a client sends `W/"<hash>"` against our strong `"<hash>"` — from
 *    overriding our decision.
 *
 * ## Security note
 *
 * Only GET / HEAD requests are intercepted.  POST / PATCH / DELETE requests
 * pass through unchanged so the middleware cannot suppress mutation responses.
 *
 * Mount as a route-level middleware (e.g. on `GET /api/apis`) to avoid adding
 * hashing overhead to every endpoint in the application.
 */
export function etagMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only intercept safe, idempotent methods
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = function (body?: unknown): Response {
    // Only process successful 200 responses
    if (res.statusCode !== 200) {
      return originalJson(body);
    }

    // Determine the ETag to use.  A route may pre-set a strong ETag on the
    // response (e.g. computed from stable payload fields to avoid hashing
    // volatile envelope metadata like `timestamp`).  When one is already
    // present we skip recomputing but still evaluate If-None-Match ourselves
    // so that Express's built-in weak-comparison freshness logic never fires.
    let etag = res.get('ETag') as string | undefined;
    if (!etag) {
      // No pre-set ETag — compute one from the full serialised body.
      const serialised = JSON.stringify(body);
      etag = generateETag(serialised);
      // Set our strong ETag before calling originalJson so Express won't
      // overwrite it with its own weak variant (Express skips auto-ETag when
      // one is already present on the response).
      res.setHeader('ETag', etag);
    }

    const ifNoneMatch = req.header('if-none-match');

    if (ifNoneMatch) {
      if (etagMatches(ifNoneMatch, etag)) {
        // Strong-comparison match — return 304 via res.end() to bypass
        // Express's own freshness pipeline entirely.
        res.status(304);
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        res.end();
        return res;
      }

      // Strong-comparison says no match, but Express's built-in `fresh` module
      // uses WEAK comparison, which would incorrectly return 304 for a client
      // sending a weak tag against our strong tag. Clear the header so Express
      // never sees it and cannot override our 200 decision.
      delete req.headers['if-none-match'];
    }

    return originalJson(body);
  } as typeof res.json;

  next();
}
