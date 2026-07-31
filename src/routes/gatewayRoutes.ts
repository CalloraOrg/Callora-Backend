import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { startUpstreamTimer, getUpstreamHealth, type UpstreamOutcome } from '../metrics.js';
import { validate } from '../middleware/validate.js';
import { createConfiguredGatewayRateLimitMiddleware } from '../middleware/gatewayRateLimit.js';
import type { GatewayDeps, ApiKey } from '../types/gateway.js';
import { buildHopByHopSet } from '../lib/hopByHop.js';
import { defaultUsageSseBroadcaster } from './usage/sse.js';
import { getDefaultBreakerRegistry, CircuitBreakerState } from '../lib/circuitBreaker.js';
import { logger } from '../logger.js';

import {
  BadGatewayError,
  ForbiddenError,
  GatewayTimeoutError,
  NotFoundError,
  PaymentRequiredError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../errors/index.js';
import { getOrCreateRequestId } from '../utils/asyncContext.js';

/** Length of the key prefix used for candidate pre-filtering (matches repository). */
const API_KEY_PREFIX_LENGTH = 16;

/**
 * Derive the SHA-256 hex digest of an API key value.
 * This matches the hash strategy used by createMapBackedGatewayApiKeyAuthMiddleware.
 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time string equality check.
 * Buffers are always the same length (padded to the longer) so the comparison
 * time is not a function of where the strings diverge — no timing oracle.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolve an API key string to its registered record using prefix-based
 * candidate filtering followed by constant-time hash comparison.
 *
 * Returns:
 *  - `{ record }` on a valid match
 *  - `{ error: 'not_found' }` when no candidate shares the prefix
 *  - `{ error: 'hash_mismatch' }` when a prefix was found but the hash did not
 *    match — callers MUST map both error variants to the same 401 response so
 *    the difference is never observable externally.
 *
 * The explicit `hash_mismatch` discriminant exists purely for internal
 * observability (logging, metrics) without leaking any information to clients.
 */
function resolveApiKey(
  apiKeyHeader: string,
  apiKeys: Map<string, ApiKey>,
): { record: ApiKey } | { error: 'not_found' | 'hash_mismatch' } {
  const prefix = apiKeyHeader.slice(0, API_KEY_PREFIX_LENGTH);
  const inboundHash = sha256Hex(apiKeyHeader);

  let prefixFound = false;

  for (const [rawKey, record] of apiKeys) {
    if (!timingSafeStringEqual(rawKey.slice(0, API_KEY_PREFIX_LENGTH), prefix)) {
      continue;
    }
    // At least one candidate shares the prefix.
    prefixFound = true;

    const storedHash = sha256Hex(rawKey);
    if (timingSafeStringEqual(inboundHash, storedHash)) {
      return { record };
    }
  }

  return { error: prefixFound ? 'hash_mismatch' : 'not_found' };
}

const CREDIT_COST_PER_CALL = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_SIZE = '1mb';

const apiIdParamsSchema = z.object({
  apiId: z.string().min(1, 'API ID is required').max(50, 'API ID too long'),
});

// ── In-memory health cache ─────────────────────────────────────────────────
//
// Keyed by apiSlug, stores the response data along with the timestamp it was
// computed. Cached entries are considered fresh for 5 seconds to avoid
// re-computing percentiles on every request.
// ────────────────────────────────────────────────────────────────────────────

interface HealthCacheEntry {
  data: {
    apiSlug: string;
    latency: { p50: number | null; p95: number | null };
    breaker: { state: 'closed' | 'open' | 'half-open' };
  };
  timestamp: number;
}

const HEALTH_CACHE_TTL_MS = 5_000;
const healthCache = new Map<string, HealthCacheEntry>();

function mapBreakerState(state: CircuitBreakerState): 'closed' | 'open' | 'half-open' {
  switch (state) {
    case CircuitBreakerState.CLOSED:
      return 'closed';
    case CircuitBreakerState.OPEN:
      return 'open';
    case CircuitBreakerState.HALF_OPEN:
      return 'half-open';
  }
}

export function createGatewayRouter(deps: GatewayDeps): Router {
  const { billing, rateLimiter, usageStore, upstreamUrl, registry } = deps;
  const breakerRegistry = deps.breakerRegistry ?? getDefaultBreakerRegistry();
  const apiKeys = deps.apiKeys ?? new Map();
  const maxBodySize = deps.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const router = Router();

  // Per-user token-bucket rate limiter for authenticated gateway requests.
  // A separate instance is created per router so tests can construct
  // isolated routers without shared limiter state.  The configured instance
  // reads limits from GATEWAY_RATE_LIMIT_WINDOW_MS / GATEWAY_RATE_LIMIT_MAX_REQUESTS.
  const gatewayRateLimit = deps.gatewayRateLimitMiddleware ?? createConfiguredGatewayRateLimitMiddleware();

  // Enforce body size limits at the router level so the gateway is self-contained
  // regardless of whether a global body parser is present. Oversized bodies surface
  // as 413 via the app-level error handler.
  router.use(express.json({ limit: maxBodySize }));
  router.use(express.urlencoded({ extended: false, limit: maxBodySize }));

  // Resolve and propagate X-Correlation-Id for the full request lifecycle.
  // Mounted after body parsers so req.id (set by requestIdMiddleware) is already
  // available as a fallback. Sets req.correlationId and the X-Correlation-Id
  // response header before any route handler runs.
  router.use(correlationMiddleware);

  // ── Gateway cursor-paginated listing endpoint ─────────────────────────────
  //
  // GET /
  //
  // Returns registered APIs with cursor-based pagination over (created_at, id).
  // Query params:
  //   cursor  - Opaque base64 cursor from a previous response
  //   limit   - Page size (default: 20, max: 100)
  //
  // Stable ordering prevents duplicates under concurrent writes.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!registry) {
        res.json({ entries: [], nextCursor: null });
        return;
      }

      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 100)
        : 20;

      const result = registry.list(cursor ?? null, limit);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ── Gateway health endpoint ──────────────────────────────────────────────
  //
  // GET /health/:apiSlug
  //
  // Public endpoint (no auth) that returns per-API latency percentiles and
  // circuit breaker state. Only aggregated upstream metrics are exposed — no
  // tenant identifiers, request paths, or raw histogram buckets are returned.
  //
  // Results are cached in-memory for 5 seconds to avoid re-computing
  // percentiles on every request.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/health/:apiSlug', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { apiSlug } = req.params;

      // Resolve slug to API id for histogram lookups
      // The histogram uses api_id (the numeric/database ID) as the label,
      // not the human-readable slug. We resolve via the registry if available.
      let apiId = apiSlug;
      if (registry) {
        const entry = registry.resolve(apiSlug);
        if (!entry) {
          next(new NotFoundError('API not found'));
          return;
        }
        apiId = entry.id;
      }

      // Check in-memory cache (keyed by apiSlug for stable caching regardless of ID resolution)
      const cached = healthCache.get(apiSlug);
      if (cached && Date.now() - cached.timestamp < HEALTH_CACHE_TTL_MS) {
        res.json(cached.data);
        return;
      }

      // Compute fresh data
      // getUpstreamHealth returns values in seconds; convert to milliseconds for the API response
      const rawLatency = await getUpstreamHealth(apiId);
      const latency = {
        p50: rawLatency.p50 !== null ? Math.round(rawLatency.p50 * 1000 * 100) / 100 : null,
        p95: rawLatency.p95 !== null ? Math.round(rawLatency.p95 * 1000 * 100) / 100 : null,
      };
      const breakerState = await breakerRegistry.getState(apiSlug);

      const data = {
        apiSlug,
        latency,
        breaker: { state: mapBreakerState(breakerState) },
      };

      // Store in cache
      healthCache.set(apiSlug, { data, timestamp: Date.now() });

      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  // ── Existing proxy route ─────────────────────────────────────────────────

  router.all(
    '/:apiId',
    validate({ params: apiIdParamsSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
        const requestId = req.id || getOrCreateRequestId(randomUUID);
        // Resolve correlation id — already computed and attached by correlationMiddleware.
        const correlationId = req.correlationId ?? requestId;

        logger.info({ requestId, correlationId, apiId: req.params.apiId, method: req.method }, 'Gateway proxy request received');

        if (!apiKeyHeader) {
          next(new UnauthorizedError('Unauthorized: missing x-api-key header'));
          return;
        }

        // Use prefix-based candidate lookup + constant-time hash comparison so
        // that a prefix match with a wrong hash produces a clean 401 instead of
        // propagating an unhandled exception as a 500. Both 'not_found' and
        // 'hash_mismatch' intentionally map to the same generic 401 message so
        // clients cannot distinguish the two cases (no timing oracle).
        const resolved = resolveApiKey(apiKeyHeader, apiKeys);
        if ('error' in resolved) {
          next(new UnauthorizedError('Unauthorized: invalid API key'));
          return;
        }

        const keyRecord = resolved.record;
        if (keyRecord.apiId !== req.params.apiId) {
          next(new UnauthorizedError('Unauthorized: invalid API key'));
          return;
        }

        // Check in-memory revocation list for immediate invalidation
        const tokenRevocationService = getTokenRevocationService();
        const apiKeyHash = sha256Hex(apiKeyHeader);
        if (tokenRevocationService.isRevoked(apiKeyHash)) {
          next(new ForbiddenError('Forbidden: API key has been revoked'));
          return;
        }

        // Also check persisted revoked flag
        if (keyRecord.revoked) {
          next(new ForbiddenError('Forbidden: API key has been revoked'));
          return;
        }

        // Per-user token-bucket rate limit (issue #870).
        // Attach the resolved record to req so the shared middleware helper can
        // read userId, then invoke it inline.  The middleware either calls next()
        // to continue, or writes the 429 response itself and returns without
        // calling next — in that case res.headersSent is true and we bail out.
        req.apiKeyRecord = {
          userId: keyRecord.developerId,
          id: keyRecord.key,
          apiId: keyRecord.apiId,
        } as Record<string, unknown>;

        let gatewayRateLimitPassed = false;
        gatewayRateLimit(req, res, () => { gatewayRateLimitPassed = true; });
        if (!gatewayRateLimitPassed) {
          // Middleware wrote the 429 response; stop processing this request.
          return;
        }

        const rateResult = await rateLimiter.check(apiKeyHeader);
        if (!rateResult.allowed) {
          const retryAfterSec = Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000);
          res.set('Retry-After', String(retryAfterSec));
          next(new TooManyRequestsError('Too Many Requests'));
          return;
        }

        // Obtain (or lazily create) the per-endpoint circuit breaker keyed by
        // apiId. A separate breaker per endpoint means one degraded upstream
        // does not trip the breaker for healthy endpoints on the same gateway.
        // We create this early so we can perform a pre-check BEFORE deducting
        // billing credits — callers must not be charged when the circuit is open.
        const endpointBreaker = breakerRegistry.getOrCreate(req.params.apiId, {
          failureThreshold: env.GATEWAY_BREAKER_FAILURE_THRESHOLD,
          cooldownMs: env.GATEWAY_BREAKER_COOLDOWN_MS,
          successThreshold: env.GATEWAY_BREAKER_SUCCESS_THRESHOLD,
        });

        // Fast-fail before billing if the circuit breaker is OPEN and still in
        // its cooldown window. wouldBlock() replicates the same cooldown logic
        // as execute() — if cooldown has elapsed execute() will transition the
        // breaker to HALF_OPEN and allow a probe, so we must NOT block here.
        if (await endpointBreaker.wouldBlock(req.params.apiId)) {
          next(new ServiceUnavailableError(
            'Service Unavailable: endpoint circuit breaker is open',
            'SERVICE_UNAVAILABLE',
          ));
          return;
        }

        const billingResult = await billing.deductCredit(
          keyRecord.developerId,
          CREDIT_COST_PER_CALL,
        );
        if (!billingResult.success) {
          next(new PaymentRequiredError('Payment Required: insufficient balance'));
          return;
        }

        let upstreamStatus = 502;
        let upstreamBody = JSON.stringify({
          code: 'BAD_GATEWAY',
          message: 'Bad Gateway: upstream unreachable',
          requestId,
        });
        let upstreamContentType = 'application/json; charset=utf-8';
        let outcome: UpstreamOutcome = 'error';
        // Safe upstream response headers to forward (populated on success)
        const upstreamResponseHeaders: Record<string, string> = {};
        const timer = startUpstreamTimer(req.params.apiId, req.method);

        try {
          const upstreamRes = await fetch(`${upstreamUrl}${req.path}`, {
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'x-request-id': requestId,
              // Propagate correlation id so multi-hop request chains are traceable
              // in upstream service logs.
              'x-correlation-id': correlationId,
            },
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          });

          upstreamStatus = upstreamRes.status;
          upstreamBody = await upstreamRes.text();
          upstreamContentType =
            upstreamRes.headers.get('content-type') ?? 'application/octet-stream';
          outcome = 'success';

          // Collect safe upstream response headers, stripping hop-by-hop headers
          // (including any names listed in the upstream Connection header value).
          const upstreamConnection = upstreamRes.headers.get('connection') ?? undefined;
          const responseStripSet = buildHopByHopSet(upstreamConnection);
          upstreamRes.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            // Also skip content-type — we set it explicitly below via res.type()
            if (!responseStripSet.has(lower) && lower !== 'content-type') {
              upstreamResponseHeaders[key] = value;
            }
          });
        } catch (error) {
          if (error instanceof CircuitBreakerOpenError) {
            // Circuit breaker is open: fast-fail with 503 to protect the caller
            // from waiting and to signal that the endpoint is temporarily unavailable.
            // Billing is NOT deducted for circuit-breaker-rejected requests.
            outcome = 'error';
            timer.stop(503, outcome);
            throw new ServiceUnavailableError(
              'Service Unavailable: endpoint circuit breaker is open',
              'SERVICE_UNAVAILABLE',
            );
          }

          if (
            (error instanceof DOMException && error.name === 'TimeoutError') ||
            (error instanceof TypeError &&
              (error as NodeJS.ErrnoException).code === 'UND_ERR_CONNECT_TIMEOUT')
          ) {
            outcome = 'timeout';
            timer.stop(504, outcome);
            logger.warn(
              { requestId, correlationId, apiId: req.params.apiId, outcome: 'timeout' },
              'Gateway proxy request timed out',
            );
            throw new GatewayTimeoutError('Upstream service timed out');
          }

          logger.warn(
            { requestId, correlationId, apiId: req.params.apiId, outcome: 'error' },
            'Gateway proxy upstream unreachable',
          );
          throw new BadGatewayError('Bad Gateway: upstream unreachable');
        } finally {
          if (outcome !== 'timeout' && outcome !== 'error') {
            timer.stop(upstreamStatus, outcome);
          }
        }

        const recorded = await usageStore.record({
          id: randomUUID(),
          requestId,
          apiKey: apiKeyHeader,
          apiKeyId: keyRecord.key,
          apiId: keyRecord.apiId,
          endpointId: 'legacy',
          userId: keyRecord.developerId,
          amountUsdc: CREDIT_COST_PER_CALL,
          statusCode: upstreamStatus,
          timestamp: new Date().toISOString(),
        });

        if (recorded) {
          defaultUsageSseBroadcaster.emitForUser(keyRecord.developerId, {
            id: randomUUID(),
            requestId,
            apiKey: apiKeyHeader,
            apiKeyId: keyRecord.key,
            apiId: keyRecord.apiId,
            endpointId: 'legacy',
            userId: keyRecord.developerId,
            amountUsdc: CREDIT_COST_PER_CALL,
            statusCode: upstreamStatus,
            timestamp: new Date().toISOString(),
          });
        }

        res.set('x-request-id', requestId);
        // Forward safe upstream response headers (hop-by-hop already stripped above)
        for (const [key, value] of Object.entries(upstreamResponseHeaders)) {
          res.set(key, value);
        }
        res.status(upstreamStatus);

        logger.info(
          { requestId, correlationId, apiId: req.params.apiId, method: req.method, upstreamStatus },
          'Gateway proxy request completed',
        );

        if (upstreamContentType.toLowerCase().includes('application/json')) {
          try {
            res.type(upstreamContentType).send(JSON.parse(upstreamBody));
            return;
          } catch {
            // Fall through and send raw body with original content type.
          }
        }

        res.type(upstreamContentType).send(upstreamBody);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

/** Exposed for testing — clears the in-memory health cache. */
export function clearHealthCache(): void {
  healthCache.clear();
}
