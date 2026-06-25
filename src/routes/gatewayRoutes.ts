import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { startUpstreamTimer, getUpstreamHealth, type UpstreamOutcome } from '../metrics.js';
import { validate } from '../middleware/validate.js';
import type { GatewayDeps } from '../types/gateway.js';
import { buildHopByHopSet } from '../lib/hopByHop.js';
import { getDefaultBreakerRegistry, CircuitBreakerState } from '../lib/circuitBreaker.js';
import {
  BadGatewayError,
  ForbiddenError,
  GatewayTimeoutError,
  NotFoundError,
  PaymentRequiredError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../errors/index.js';

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

  // Enforce body size limits at the router level so the gateway is self-contained
  // regardless of whether a global body parser is present. Oversized bodies surface
  // as 413 via the app-level error handler.
  router.use(express.json({ limit: maxBodySize }));
  router.use(express.urlencoded({ extended: false, limit: maxBodySize }));

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
      const breakerState = breakerRegistry.getState(apiSlug);

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
        const requestId = randomUUID();

        if (!apiKeyHeader) {
          next(new UnauthorizedError('Unauthorized: missing x-api-key header'));
          return;
        }

        const keyRecord = apiKeys.get(apiKeyHeader);
        if (!keyRecord || keyRecord.apiId !== req.params.apiId) {
          next(new UnauthorizedError('Unauthorized: invalid API key'));
          return;
        }

        if (keyRecord.revoked) {
          next(new ForbiddenError('Forbidden: API key has been revoked'));
          return;
        }

        const rateResult = await rateLimiter.check(apiKeyHeader);
        if (!rateResult.allowed) {
          const retryAfterSec = Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000);
          res.set('Retry-After', String(retryAfterSec));
          next(new TooManyRequestsError('Too Many Requests'));
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
            headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
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
          if (
            (error instanceof DOMException && error.name === 'TimeoutError') ||
            (error instanceof TypeError &&
              (error as NodeJS.ErrnoException).code === 'UND_ERR_CONNECT_TIMEOUT')
          ) {
            outcome = 'timeout';
            timer.stop(504, outcome);
            throw new GatewayTimeoutError('Upstream service timed out');
          }

          throw new BadGatewayError('Bad Gateway: upstream unreachable');
        } finally {
          if (outcome !== 'timeout') {
            timer.stop(upstreamStatus, outcome);
          }
        }

        await usageStore.record({
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

        res.set('x-request-id', requestId);
        // Forward safe upstream response headers (hop-by-hop already stripped above)
        for (const [key, value] of Object.entries(upstreamResponseHeaders)) {
          res.set(key, value);
        }
        res.status(upstreamStatus);

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
