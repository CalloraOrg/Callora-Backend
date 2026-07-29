import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ProxyDeps, ProxyConfig, ApiRegistryEntry, EndpointPricing } from '../types/gateway.js';
import { resolveEndpointPrice } from '../data/apiRegistry.js';
import {
  startUpstreamTimer,
  recordProxyPrematureAbort,
  type UpstreamOutcome,
  setGatewayUpstreamBreakerState,
  recordEndpointThroughputSaturation,
} from '../metrics.js';
import { createMapBackedGatewayApiKeyAuthMiddleware } from '../middleware/gatewayApiKeyAuth.js';
import { createConfiguredPerKeyConcurrencyMiddleware } from '../middleware/perKeyConcurrency.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { buildHopByHopSet } from '../lib/hopByHop.js';
import {
  buildUpstreamTargetUrl,
  DEFAULT_UPSTREAM_HOST_ALLOWLIST,
  validateResolvedUpstreamTarget,
} from '../lib/upstreamTarget.js';
import {
  BadGatewayError,
  GatewayTimeoutError,
  InternalServerError,
  PaymentRequiredError,
  ServiceUnavailableError,
  TooManyRequestsError,
} from '../errors/index.js';
import { CircuitBreakerOpenError } from '../lib/errors.js';
import { CircuitBreaker } from '../lib/circuitBreaker.js';
import { env } from '../config/env.js';
import { getOrCreateRequestId } from '../utils/asyncContext.js';
import { defaultUsageSseBroadcaster } from './usage/sse.js';
import { logger } from '../logger.js';

/**
 * Headers that must never be forwarded to the upstream server.
 *
 * Includes all RFC 7230 §6.1 hop-by-hop headers plus gateway-specific
 * internal headers (host, x-api-key) that must not leak to the origin.
 * Dynamic Connection-listed headers are stripped at request time via
 * buildHopByHopSet().
 */
const DEFAULT_STRIP_HEADERS = [
  // Hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Sensitive and gateway-internal headers
  'host',
  'x-api-key',
  'authorization',
  'cookie',
  'x-forwarded-for',
  'x-real-ip',
];

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveConfig(partial?: Partial<ProxyConfig>): ProxyConfig {
  return {
    timeoutMs: partial?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stripHeaders: partial?.stripHeaders ?? DEFAULT_STRIP_HEADERS,
    recordableStatuses: partial?.recordableStatuses ?? ((code) => code >= 200 && code < 300),
    allowedHosts: partial?.allowedHosts ?? [...DEFAULT_UPSTREAM_HOST_ALLOWLIST],
  };
}

/**
 * Factory that creates the `/v1/call` proxy router.
 *
 * Route: ALL /v1/call/:apiSlugOrId/*
 *
 * Flow:
 *   1. Drain guard — during graceful shutdown, new requests are rejected
 *      immediately with `503 Service Unavailable` so load balancers can route
 *      traffic elsewhere.  In-flight requests that arrived before shutdown
 *      was signalled are allowed to complete normally.
 *   2. Resolve API from registry by slug or ID → 404 if unknown
 *   3. Validate x-api-key header → 401
 *   4. Rate-limit check → 429
 *   5. Pre-proxy balance check → 402 if depleted
 *   6. Build upstream URL, find price, forward safe headers, add X-Request-Id
 *   7. Proxy request with configurable timeout → 504 on timeout
 *   8. Stream upstream response back to caller
 *   9. [Non-blocking] Record usage and deduct billing if status is recordable
 */
export function createProxyRouter(deps: ProxyDeps): Router {
  const { billing, rateLimiter, usageStore, registry, circuitBreakerStore, drainState } = deps;
  const config = resolveConfig(deps.proxyConfig);
  const router = Router();
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: env.PROXY_BREAKER_FAILURE_THRESHOLD,
    cooldownMs: env.PROXY_BREAKER_COOLDOWN_MS,
    successThreshold: env.PROXY_BREAKER_SUCCESS_THRESHOLD,
  }, circuitBreakerStore);
  const authMiddleware = deps.authMiddleware ?? createMapBackedGatewayApiKeyAuthMiddleware({
    apiKeys: deps.apiKeys,
    resolveApiContext(req) {
      const api = registry.resolve(req.params.apiSlugOrId);
      if (!api) {
        return null;
      }

      const wildcardPath = req.params[0] ?? '';
      const endpoint = resolveEndpointPrice(api.endpoints, wildcardPath);
      return { api, endpoint };
    },
    getApiId(api) {
      return String(api.id);
    },
  });

  // Tracks in-flight requests per API key on the shared semaphore that
  // GET /api/admin/keys/concurrency reads from. Must run after authMiddleware
  // so that req.apiKeyRecord is populated.
  const perKeyConcurrency = deps.perKeyConcurrency ?? createConfiguredPerKeyConcurrencyMiddleware();

  // Idempotency middleware for POST/PATCH to prevent duplicate downstream calls.
  // Caches request→response keyed by Idempotency-Key header, ensuring safe retries.
  // See docs/api-proxy-idempotency.md for the contract.
  const idempotencyForProxy = (req: Request, res: Response, next: NextFunction): void => {
    idempotencyMiddleware(req, res, next, {
      keyFromHeader: 'idempotency-key',
      retentionSeconds: env.IDEMPOTENCY_RETENTION_WINDOW_SECONDS,
      bodyExcludingKeys: ['idempotencyKey'],
    });
  };

  /**
   * Drain guard middleware.
   *
   * Runs before all other route handlers.  If the server has entered its
   * graceful-shutdown drain phase, new proxy requests are rejected immediately
   * with `503 Service Unavailable` so upstream load balancers can route
   * traffic to healthy instances.  The response includes:
   *
   *   - `Connection: close`  — instructs the load balancer not to reuse
   *                            this socket for future requests.
   *   - `Retry-After: 0`     — advises the client to retry immediately
   *                            (the new instance should be ready).
   *
   * Requests that are already in flight when the drain begins are unaffected
   * and are tracked by the in-flight counter in the drain tracker
   * (see `src/lifecycle/shutdown.ts`).
   */
  const drainGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (drainState?.isDraining()) {
      const requestId = req.id ?? getOrCreateRequestId(randomUUID);
      logger.info(
        { requestId, path: req.path, method: req.method },
        '[proxy:drain] Rejecting new proxy request during graceful shutdown',
      );
      res.set('Connection', 'close');
      res.set('Retry-After', '0');
      next(new ServiceUnavailableError(
        'Server is shutting down. Please retry your request on another instance.',
        'SERVICE_UNAVAILABLE',
      ));
      return;
    }
    next();
  };

  // Use a param of 0 to capture the wildcard path (everything after the slug)
  // POST and PATCH routes get idempotency protection; GET/DELETE are naturally safe.
  router.post('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, idempotencyForProxy, handleProxy);
  router.patch('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, idempotencyForProxy, handleProxy);
  router.post('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, idempotencyForProxy, handleProxy);
  router.patch('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, idempotencyForProxy, handleProxy);

  // GET, DELETE, and other methods pass through without idempotency caching
  router.get('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.delete('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.put('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.options('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.head('/:apiSlugOrId/*', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);

  router.get('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.delete('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.put('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.options('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);
  router.head('/:apiSlugOrId', drainGuard, authMiddleware, perKeyConcurrency, handleProxy);

  async function handleProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const requestId = req.id || getOrCreateRequestId(randomUUID);
      const apiEntry = req.api as unknown as ApiRegistryEntry | undefined;
      const endpoint = req.endpoint as unknown as EndpointPricing | undefined;
      const apiKeyHeader = req.apiKeyValue;
      const keyRecord = req.apiKeyRecord as {
        id: string;
        userId: string;
        apiId: string;
        rateLimitPerMinute?: number | null;
      } | undefined;

      if (!apiEntry || !endpoint || !apiKeyHeader || !keyRecord) {
        next(
          new InternalServerError(
            'Gateway authentication context missing',
            'GATEWAY_AUTH_CONTEXT_MISSING',
          ),
        );
        return;
      }

      const breakerKey = String(apiEntry.id);

      // Update circuit breaker state metric
      const currentMetrics = await circuitBreaker.getMetrics(breakerKey);
      const stateValue = currentMetrics.state === 'CLOSED' ? 0 : currentMetrics.state === 'OPEN' ? 1 : 2;
      setGatewayUpstreamBreakerState(breakerKey, stateValue);

      // 3. Rate-limit check
      const rateResult = await rateLimiter.check(apiKeyHeader, res.locals.apiKeyTier as string | undefined);
      if (!rateResult.allowed) {
        const retryAfterSec = Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000);
        res.set('Retry-After', String(retryAfterSec));
        next(new TooManyRequestsError('Too Many Requests'));
        return;
      }

      // 4. Pre-proxy balance check (ensure they have funds, deduct later)
      const currentBalance = await billing.checkBalance(keyRecord.userId);
      if (currentBalance <= 0) {
        next(new PaymentRequiredError('Payment Required: insufficient balance'));
        return;
      }

      // 5. Build upstream URL & find price
      // req.params[0] captures the wildcard portion after the slug
      const wildcardPath = req.params[0] ?? '';
      const upstreamTarget = buildUpstreamTargetUrl(apiEntry.base_url, wildcardPath);
      let safeUpstreamTarget: string;

      try {
        safeUpstreamTarget = await validateResolvedUpstreamTarget(upstreamTarget, {
          allowedHosts: config.allowedHosts,
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : 'Configured upstream target is not allowed.';
        throw new BadGatewayError(message, 'UPSTREAM_TARGET_BLOCKED');
      }

      // 6. Build forwarded headers — strip hop-by-hop and gateway-internal headers.
      // buildHopByHopSet() also strips any additional names listed in the
      // incoming Connection header value (RFC 7230 §6.1).
      const forwardHeaders: Record<string, string> = {};
      const connectionValue = typeof req.headers['connection'] === 'string'
        ? req.headers['connection']
        : undefined;
      const stripSet = buildHopByHopSet(connectionValue);
      // Always strip gateway-internal headers regardless of Connection listing
      for (const h of config.stripHeaders) stripSet.add(h.toLowerCase());

      for (const [key, value] of Object.entries(req.headers)) {
        if (!stripSet.has(key.toLowerCase()) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }
      forwardHeaders['x-request-id'] = requestId;

      // 7. Proxy with circuit breaker and timeout
      let upstreamStatus = 502;
      const timer = startUpstreamTimer(apiEntry.id, req.method);

      try {
        const upstreamRes = await circuitBreaker.execute(breakerKey, async () => {
          const res = await fetch(safeUpstreamTarget, {
            method: req.method,
            headers: forwardHeaders,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
            signal: AbortSignal.timeout(config.timeoutMs),
          });
          return res;
        });

        upstreamStatus = upstreamRes.status;
        timer.stop(upstreamStatus, 'success');

        // Update circuit breaker state metric after success
        const updatedMetrics = await circuitBreaker.getMetrics(breakerKey);
        const updatedStateValue = updatedMetrics.state === 'CLOSED' ? 0 : updatedMetrics.state === 'OPEN' ? 1 : 2;
        setGatewayUpstreamBreakerState(breakerKey, updatedStateValue);

        // Forward response headers — strip hop-by-hop headers from the upstream
        // response, including any names listed in the upstream Connection header.
        const upstreamConnection = upstreamRes.headers.get('connection') ?? undefined;
        const responseStripSet = buildHopByHopSet(upstreamConnection);
        upstreamRes.headers.forEach((value, key) => {
          if (!responseStripSet.has(key.toLowerCase())) {
            res.set(key, value);
          }
        });
        res.set('x-request-id', requestId);

        // Stream body back
        res.status(upstreamStatus);
        if (upstreamRes.body) {
          const reader = upstreamRes.body.getReader();
          const pump = async (): Promise<void> => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          await pump();
        } else {
          const text = await upstreamRes.text();
          res.send(text);
        }
      } catch (err: unknown) {
        let outcome: UpstreamOutcome = 'error';

        if (err instanceof CircuitBreakerOpenError) {
          // Circuit breaker open — don't bill the caller
          upstreamStatus = 502;
          timer.stop(upstreamStatus, outcome);
          // Update metric
          await circuitBreaker.getMetrics(breakerKey);
          setGatewayUpstreamBreakerState(breakerKey, 1);
          throw new BadGatewayError('Bad Gateway: upstream unavailable');
        } else if (err instanceof DOMException && err.name === 'TimeoutError') {
          upstreamStatus = 504;
          outcome = 'timeout';
          timer.stop(upstreamStatus, outcome);
          // Update metric after failure
          const failedMetrics = await circuitBreaker.getMetrics(breakerKey);
          const failedStateValue = failedMetrics.state === 'CLOSED' ? 0 : failedMetrics.state === 'OPEN' ? 1 : 2;
          setGatewayUpstreamBreakerState(breakerKey, failedStateValue);
          throw new GatewayTimeoutError('Upstream service timed out');
        } else if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'UND_ERR_CONNECT_TIMEOUT') {
          upstreamStatus = 504;
          outcome = 'timeout';
          timer.stop(upstreamStatus, outcome);
          // Update metric after failure
          const failedMetrics = await circuitBreaker.getMetrics(breakerKey);
          const failedStateValue = failedMetrics.state === 'CLOSED' ? 0 : failedMetrics.state === 'OPEN' ? 1 : 2;
          setGatewayUpstreamBreakerState(breakerKey, failedStateValue);
          throw new GatewayTimeoutError('Upstream service timed out');
        } else {
          upstreamStatus = 502;
          timer.stop(upstreamStatus, outcome);
          // Update metric after failure
          const failedMetrics = await circuitBreaker.getMetrics(breakerKey);
          const failedStateValue = failedMetrics.state === 'CLOSED' ? 0 : failedMetrics.state === 'OPEN' ? 1 : 2;
          setGatewayUpstreamBreakerState(breakerKey, failedStateValue);
          throw new BadGatewayError('Bad Gateway: upstream unreachable');
        }
      }

      // 8. Keep metering and billing consistent — but ONLY after the response
      //    has been fully delivered to the caller.
      //
      //    We distinguish two response lifecycle events:
      //      • 'finish' — Node/Express has flushed all data and ended the
      //                   response normally.  This is the success path; we
      //                   record usage here.
      //      • 'close'  — The underlying socket was torn down.  When this
      //                   fires WITHOUT a prior 'finish' it means the client
      //                   disconnected mid-stream (premature abort).  In that
      //                   case we must NOT record usage because the caller
      //                   never received the response.
      //
      //    Using a one-shot 'finish' listener (registered before we start
      //    streaming) ensures we capture the event even if the stream
      //    completes synchronously.  The 'close' listener is a guard that
      //    cancels the deferred work when the socket drops first.
      if (config.recordableStatuses(upstreamStatus)) {
        // Track whether the response finished cleanly before the socket closed.
        let responseFinished = false;

        res.once('finish', () => {
          responseFinished = true;

          // Run usage recording in a non-blocking microtask so it does not
          // delay the event loop that is already handling the next request.
          setImmediate(() => {
            void (async () => {
              try {
                const recorded = await usageStore.record({
                  id: randomUUID(), // ID of the usage event itself
                  requestId,        // Idempotency key — prevents double-counts
                  apiKey: apiKeyHeader,
                  apiKeyId: keyRecord.id,
                  apiId: String(apiEntry.id),
                  endpointId: endpoint.endpointId,
                  userId: keyRecord.userId,
                  amountUsdc: endpoint.priceUsdc,
                  statusCode: upstreamStatus,
                  timestamp: new Date().toISOString(),
                });

                if (recorded) {
                  defaultUsageSseBroadcaster.emitForUser(keyRecord.userId, {
                    id: randomUUID(),
                    requestId,
                    apiKey: apiKeyHeader,
                    apiKeyId: keyRecord.id,
                    apiId: String(apiEntry.id),
                    endpointId: endpoint.endpointId,
                    userId: keyRecord.userId,
                    amountUsdc: endpoint.priceUsdc,
                    statusCode: upstreamStatus,
                    timestamp: new Date().toISOString(),
                  });
                }

                recordEndpointThroughputSaturation({
                  apiId: String(apiEntry.id),
                  endpointId: endpoint.endpointId,
                  endpointPath: endpoint.path,
                  advertisedLimitPerMinute: Number(keyRecord?.rateLimitPerMinute ?? 0),
                  observedAt: Date.now(),
                });

                // Only deduct billing if this requestId hasn't been processed
                // before (idempotency guard inside usageStore.record).
                if (recorded && endpoint.priceUsdc > 0) {
                  billing.deductCredit(keyRecord.userId, endpoint.priceUsdc).catch((err) => {
                    console.error('Background billing deduction failed:', err);
                  });
                }
              } catch (err) {
                console.error('Background usage recording failed:', err);
              }
            })();
          });
        });

        res.once('close', () => {
          // 'close' fires after 'finish' on a normal response, or on its own
          // when the socket is destroyed prematurely.  Only treat it as an
          // abort when 'finish' has NOT already fired.
          if (!responseFinished) {
            recordProxyPrematureAbort();
          }
        });
      }
    } catch (error) {
      next(error);
    }
  }

  return router;
}
