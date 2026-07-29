/**
 * src/middleware/auditEnrich.ts
 *
 * Middleware that attaches enriched forensic context to every request so
 * that `logger.audit()` call sites do not have to repeat the same boilerplate.
 *
 * Fields attached to `req.auditContext`:
 *   • clientIp      — resolved by the shared getClientIp() utility
 *   • userAgent     — raw User-Agent header (trimmed, max 512 chars)
 *   • tenantId      — developer user_id extracted from auth middleware;
 *                     NULL for unauthenticated / admin-key paths
 *   • correlationId — x-request-id (set earlier by requestIdMiddleware)
 *   • bodyHash      — HMAC-SHA256(JSON body, AUDIT_BODY_HASH_SECRET), hex;
 *                     computed lazily on first access via a getter so requests
 *                     without a body pay no hashing cost
 *
 * The HMAC key is read from process.env.AUDIT_BODY_HASH_SECRET.
 * If the env var is absent the hash is omitted (null) and a one-time startup
 * warning is emitted so operators are reminded to configure it.
 *
 * Mount order: after requestIdMiddleware and express.json(), before routes.
 *
 * Usage in a route:
 *   logger.audit('MY_EVENT', actor, {
 *     ...req.auditContext,
 *     diff: { ... },
 *   });
 */

import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../lib/clientIp.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

/**
 * Maximum byte-length kept for User-Agent values before truncation.
 * Guards against log-flooding via oversized UA strings.
 */
export const USER_AGENT_MAX_LENGTH = 512;

/** Warn once at startup if the HMAC key is missing. */
let _warnedMissingKey = false;

// ---------------------------------------------------------------------------
// HMAC helper
// ---------------------------------------------------------------------------

/**
 * Computes an HMAC-SHA256 hex digest of `body` keyed with `secret`.
 *
 * Using HMAC rather than plain SHA-256 means:
 *   1. An attacker with DB read access cannot brute-force the body from the hash.
 *   2. Hashes are unforgeable without the secret, making tamper detection reliable.
 *
 * Returns null when:
 *   - `secret` is empty / not configured
 *   - `body` is null / undefined / not an object
 */
export function computeBodyHash(
  body: unknown,
  secret: string | undefined,
): string | null {
  if (!secret) {
    if (!_warnedMissingKey) {
      logger.warn(
        '[auditEnrich] AUDIT_BODY_HASH_SECRET is not set — body_hash will be null. ' +
        'Set this env var to enable keyed body hashing for forensics.',
      );
      _warnedMissingKey = true;
    }
    return null;
  }

  if (body === null || body === undefined || typeof body !== 'object') {
    return null;
  }

  try {
    const payload = JSON.stringify(body);
    return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  } catch {
    // JSON.stringify can throw for objects with circular references.
    // Log a warning and continue — a missing hash is better than a 500.
    logger.warn('[auditEnrich] Failed to serialise request body for hashing — body_hash omitted.');
    return null;
  }
}

/**
 * Sanitise the User-Agent header: trim whitespace and truncate to
 * USER_AGENT_MAX_LENGTH to prevent log-flooding.
 */
export function sanitizeUserAgent(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > USER_AGENT_MAX_LENGTH
    ? trimmed.slice(0, USER_AGENT_MAX_LENGTH)
    : trimmed;
}

// ---------------------------------------------------------------------------
// AuditContext type
// ---------------------------------------------------------------------------

export interface AuditContext {
  /** Resolved client IP address (proxy-aware). */
  clientIp: string;
  /** Sanitised User-Agent string, or undefined if not present. */
  userAgent: string | undefined;
  /**
   * Developer user_id (tenant). Set by requireAuth / gatewayApiKeyAuth.
   * Null for unauthenticated requests and admin-key paths.
   */
  tenantId: string | null;
  /** X-Request-Id correlation token for joining audit rows to access logs. */
  correlationId: string | undefined;
  /**
   * HMAC-SHA256 hex digest of the JSON request body, keyed with
   * AUDIT_BODY_HASH_SECRET. Null when there is no body or the key is absent.
   */
  bodyHash: string | null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Attaches `req.auditContext` to every inbound request.
 *
 * Must be mounted:
 *   AFTER  requestIdMiddleware  (so req.id is populated)
 *   AFTER  express.json()       (so req.body is parsed)
 *   BEFORE route handlers       (so context is available in routes)
 *
 * The `tenantId` field is populated reactively: `requireAuth` sets
 * `req.developerId` (or `res.locals.authenticatedUser.id`).  Because
 * middleware runs before routes, `tenantId` may be null at attachment time
 * for routes that authenticate inside the handler — those routes should
 * override `tenantId` explicitly when calling `logger.audit()`.
 */
export function auditEnrichMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const secret = process.env.AUDIT_BODY_HASH_SECRET;

  const clientIp = getClientIp(req, TRUST_PROXY);
  const userAgent = sanitizeUserAgent(req.get('User-Agent'));

  // correlationId: prefer the sanitized id already set by requestIdMiddleware,
  // fall back to the raw header value.
  const correlationId: string | undefined =
    (req as Request & { id?: string }).id ??
    (typeof req.headers['x-request-id'] === 'string'
      ? req.headers['x-request-id']
      : undefined) ??
    (typeof req.headers['x-correlation-id'] === 'string'
      ? req.headers['x-correlation-id']
      : undefined);

  // tenantId: populated by requireAuth (req.developerId) or gatewayApiKeyAuth.
  // At middleware-mount time this is typically null for most routes; routes that
  // authenticate must include it when calling logger.audit().
  const tenantId: string | null = (req as Request & { developerId?: string }).developerId ?? null;

  // bodyHash: compute now so the hash covers the body as parsed — before any
  // route handler might mutate req.body.
  const bodyHash = computeBodyHash(req.body, secret);

  (req as Request & { auditContext: AuditContext }).auditContext = {
    clientIp,
    userAgent,
    tenantId,
    correlationId,
    bodyHash,
  };

  next();
}