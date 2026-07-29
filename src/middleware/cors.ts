import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { errorEnvelope, getRequestId } from '../lib/envelope.js';

/**
 * Options accepted by {@link createCorsAllowlistMiddleware}.
 *
 * `allowedOrigins` is the canonical allowlist — matched exactly (no wildcards).
 * When the list is empty every cross-origin request is denied. Pair this with
 * `Access-Control-Allow-Credentials` only when the protected route's parents
 * already require authenticated callers.
 */
export interface CorsAllowlistOptions {
  /** Exact-match origins permitted to make cross-origin requests. */
  allowedOrigins: string[];
  /**
   * When `true` the `Access-Control-Allow-Credentials: true` header is
   * included on both preflight and actual responses. Defaults to `false`.
   */
  allowCredentials?: boolean;
  /**
   * `Access-Control-Max-Age` value (seconds) returned on preflight responses.
   * The default (600s = 10 minutes) is the value recommended by MDN for
   * security-sensitive endpoints — short enough to be invalidated by
   * allowlist changes, long enough to avoid hammering the server with
   * preflight requests.
   */
  maxAgeSeconds?: number;
}

/** Default preflight cache window (10 minutes). */
const DEFAULT_MAX_AGE_SECONDS = 600;

/** Stable error code returned with every CORS denial envelope. */
export const CORS_ERROR_CODE = 'ORIGIN_NOT_ALLOWED';

/**
 * Parse a comma-separated allowlist string (as loaded from an environment
 * variable) into a deduplicated, trimmed array of origins. Whitespace-only
 * and empty entries are dropped, so a config such as
 *   `MAINTENANCE_CORS_ALLOWED_ORIGINS=' a, b , , a '`
 * produces `['a', 'b']` — the parser is intentionally tolerant because the
 * values come from operators hand-editing .env files.
 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string') {
    return [];
  }

  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Extract the `Origin` header in a type-safe way and trim trailing
 * whitespace. Returns `undefined` when the header is missing or non-string
 * so callers can branch on its presence without further checks.
 */
function parseOriginHeader(req: Request): string | undefined {
  const raw = req.header('Origin');
  if (!raw || typeof raw !== 'string') {
    return undefined;
  }
  return raw.trim();
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(origin);
}

/**
 * Send a 403 response using the canonical error envelope from
 * `src/lib/envelope.ts` so frontend clients (and tests) that understand the
 * standard envelope shape can handle denials uniformly across handlers.
 *
 * The `Vary: Origin` header is set on denials so caches do not confuse
 * per-origin responses — see the WHATWG fetch spec on CORS caching.
 */
function sendCorsDenied(res: Response, origin: string, requestId: string): void {
  // Per the HTTP cache-key rules, varying responses *must* declare Vary so
  // shared caches don't serve one origin's error payload to another.
  res.setHeader('Vary', 'Origin');
  res.status(403).json(
    errorEnvelope(
      CORS_ERROR_CODE,
      `Origin "${origin}" is not allowed`,
      requestId,
    ),
  );
}

function setCorsHeaders(
  res: Response,
  origin: string,
  options: CorsAllowlistOptions,
): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (options.allowCredentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

/**
 * Handle an OPTIONS preflight request by setting the preflight-specific
 * `Allow-Methods` / `Allow-Headers` / `Max-Age` headers and ending the
 * response with 204 No Content. `Access-Control-Allow-Origin`, `Vary`,
 * and `Access-Control-Allow-Credentials` are already set by the caller
 * via {@link setCorsHeaders}, so they are intentionally NOT repeated here.
 *
 * `Max-Age` is the cue browsers use to cache the preflight result, so the
 * requestee does not have to be hit again for the cached window.
 */
function handlePreflight(
  res: Response,
  _origin: string,
  options: CorsAllowlistOptions,
): void {
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, DELETE, OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-api-key, x-request-id',
  );
  res.setHeader(
    'Access-Control-Max-Age',
    String(options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS),
  );
  res.status(204).end();
}

/**
 * Create an Express middleware that enforces an exact-match CORS allowlist.
 *
 * Behaviour:
 *  - Missing `Origin` header → 403 with `ORIGIN_NOT_ALLOWED`.
 *  - Origin not in `allowedOrigins` → 403 with `ORIGIN_NOT_ALLOWED`.
 *  - Empty `allowedOrigins` → all cross-origin requests are denied (deny
 *    by default; the empty allowlist is the safe, fail-closed state).
 *  - Allowed preflight (OPTIONS) → 204 with full `Access-Control-*` headers.
 *  - Allowed non-preflight → continues the request, setting the `Allow-*`
 *    headers the browser needs to read the response.
 *
 * The middleware emits a structured `logger.warn({ origin, method, path,
 * requestId })` entry on every denial so SOC tooling has the correlation id
 * it needs to tie events back to a specific client request.
 */
export function createCorsAllowlistMiddleware(
  options: CorsAllowlistOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const { allowedOrigins } = options;

  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    logger.warn('[cors] allowlist is empty — all origins will be denied');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = parseOriginHeader(req);
    // Pull the request id through the canonical helper so the envelope and
    // the structured warning line up byte-for-byte.
    const requestId = getRequestId(req as Request & { headers: Record<string, string | string[] | undefined> });

    if (!origin) {
      logger.warn('[cors] missing Origin header', {
        method: req.method,
        path: req.path,
        requestId,
      });
      res.setHeader('Vary', 'Origin');
      res.status(403).json(
        errorEnvelope(CORS_ERROR_CODE, 'Origin header is required', requestId),
      );
      return;
    }

    if (!isOriginAllowed(origin, allowedOrigins)) {
      logger.warn('[cors] origin not allowed', {
        origin,
        method: req.method,
        path: req.path,
        requestId,
        allowedOrigins,
      });
      sendCorsDenied(res, origin, requestId);
      return;
    }

    setCorsHeaders(res, origin, options);

    if (req.method === 'OPTIONS') {
      handlePreflight(res, origin, options);
      return;
    }

    next();
  };
}

/**
 * Subscription-route CORS middleware factory.
 *
 * Reads the `SUBSCRIPTION_CORS_ALLOWED_ORIGINS` environment variable on first
 * use (lazy) so unit tests that mutate `process.env` after module load
 * continue to work. The factory returns the same middleware instance on
 * every subsequent request to avoid re-parsing the allowlist per request;
 * to pick up runtime changes the operator must restart the process.
 *
 * NOTE: the matching schema entry in `src/config/env.ts` is intentionally
 * left as a `z.string()` (no transform) — it is documentation-only. If a
 * future maintainer attempts to transform it to `z.array(z.string())` in
 * the schema, the runtime env read below will silently use the raw string
 * and callers will see the old un-parsed value. Coordinate any schema
 * changes with this middleware.
 *
 * Defaults to:
 *  - `allowCredentials: false` — subscriptions authenticate via JWT in headers.
 *  - `maxAgeSeconds: 600`      — 10 minute preflight cache.
 *
 * If `SUBSCRIPTION_CORS_ALLOWED_ORIGINS` is unset/empty every cross-origin
 * request to the subscription route is denied (deny by default).
 */
export function createSubscriptionCorsMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  let middleware: ReturnType<typeof createCorsAllowlistMiddleware> | null =
    null;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!middleware) {
      const allowedOrigins = parseAllowedOrigins(
        process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS,
      );
      logger.info('[cors] subscription allowlist loaded', {
        originCount: allowedOrigins.length,
      });
      middleware = createCorsAllowlistMiddleware({
        allowedOrigins,
        allowCredentials: false,
        maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
      });
    }
    middleware(req, res, next);
  };
}

/**
 * Maintenance-route CORS middleware factory.
 *
 * Reads the `MAINTENANCE_CORS_ALLOWED_ORIGINS` environment variable on first
 * use (lazy) so unit tests that mutate `process.env` after module load
 * continue to work. The factory returns the same middleware instance on
 * every subsequent request to avoid re-parsing the allowlist per request;
 * to pick up runtime changes the operator must restart the process.
 *
 * NOTE: the matching schema entry in `src/config/env.ts` is intentionally
 * left as a `z.string()` (no transform) — it is documentation-only. If a
 * future maintainer attempts to transform it to `z.array(z.string())` in
 * the schema, the runtime env read below will silently use the raw string
 * and callers will see the old un-parsed value. Coordinate any schema
 * changes with this middleware.
 *
 * Defaults to:
 *  - `allowCredentials: true` — the maintenance banner UI is authed.
 *  - `maxAgeSeconds: 600`      — 10 minute preflight cache.
 *
 * If `MAINTENANCE_CORS_ALLOWED_ORIGINS` is unset/empty every cross-origin
 * request to the maintenance route is denied (deny by default).
 */
export function createMaintenanceCorsMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  let middleware: ReturnType<typeof createCorsAllowlistMiddleware> | null =
    null;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!middleware) {
      const allowedOrigins = parseAllowedOrigins(
        process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS,
      );
      logger.info('[cors] maintenance allowlist loaded', {
        originCount: allowedOrigins.length,
      });
      middleware = createCorsAllowlistMiddleware({
        allowedOrigins,
        allowCredentials: true,
        maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
      });
    }
    middleware(req, res, next);
  };
}
