import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ProxyDeps, ProxyConfig, ApiRegistryEntry, EndpointPricing } from '../types/gateway.js';
import { resolveEndpointPrice } from '../data/apiRegistry.js';
import { startUpstreamTimer, type UpstreamOutcome } from '../metrics.js';
import { createMapBackedGatewayApiKeyAuthMiddleware } from '../middleware/gatewayApiKeyAuth.js';
import { buildHopByHopSet, STATIC_HOP_BY_HOP } from '../lib/hopByHop.js';

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
];

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveConfig(partial?: Partial<ProxyConfig>): ProxyConfig {
  return {
    timeoutMs: partial?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stripHeaders: partial?.stripHeaders ?? DEFAULT_STRIP_HEADERS,
    recordableStatuses: partial?.recordableStatuses ?? ((code) => code >= 200 && code < 300),
  };
}

/**
 * Factory that creates the `/v1/call` proxy router.
 *
 * Route: ALL /v1/call/:apiSlugOrId/*
 *
 * Flow:
 *   1. Resolve API from registry by slug or ID → 404 if unknown
 *   2. Validate x-api-key header → 401
 *   3. Rate-limit check → 429
 *   4. Pre-proxy balance check → 402 if depleted
 *   5. Build upstream URL, find price, forward safe headers, add X-Request-Id
 *   6. Proxy request with configurable timeout → 504 on timeout
 *   7. Stream upstream response back to caller
 *   8. [Non-blocking] Record usage and deduct billing if status is recordable
 */
export function createProxyRouter(deps: ProxyDeps): Router {
  const { billing, rateLimiter, usageStore, registry } = deps;
  const config = resolveConfig(deps.proxyConfig);
  const router = Router();
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

  // Use a param of 0 to capture the wildcard path (everything after the slug)
  router.all('/:apiSlugOrId/*', authMiddleware, handleProxy);
  // Also handle requests without a trailing path (e.g. /v1/call/my-api)
  router.all('/:apiSlugOrId', authMiddleware, handleProxy);

  async function handleProxy(req: Request, res: Response): Promise<void> {
    const requestId = randomUUID();
    const apiEntry = req.api as unknown as ApiRegistryEntry | undefined;
    const endpoint = req.endpoint as unknown as EndpointPricing | undefined;
    const apiKeyHeader = req.apiKeyValue;
    const keyRecord = req.apiKeyRecord as { id: string; userId: string; apiId: string } | undefined;

    if (!apiEntry || !endpoint || !apiKeyHeader || !keyRecord) {
      res.status(500).json({ error: 'Gateway authentication context missing', requestId });
      return;
    }

    // 3. Rate-limit check
    const rateResult = rateLimiter.check(apiKeyHeader);
    if (!rateResult.allowed) {
      const retryAfterSec = Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfterMs: rateResult.retryAfterMs,
        requestId,
      });
      return;
    }

    // 4. Pre-proxy balance check (ensure they have funds, deduct later)
    const currentBalance = await billing.checkBalance(keyRecord.userId);
    if (currentBalance <= 0) {
      res.status(402).json({
        error: 'Payment Required: insufficient balance',
        balance: currentBalance,
        requestId,
      });
      return;
    }

    // 5. Build upstream URL & find price
    // req.params[0] captures the wildcard portion after the slug
    const wildcardPath = req.params[0] ?? '';
    const upstreamTarget = wildcardPath
      ? `${apiEntry.base_url}/${wildcardPath}`
      : apiEntry.base_url;

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

    // 7. Proxy with timeout
    let upstreamStatus = 502;
    const timer = startUpstreamTimer(apiEntry.id, req.method);

    try {
      const upstreamRes = await fetch(upstreamTarget, {
        method: req.method,
        headers: forwardHeaders,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      upstreamStatus = upstreamRes.status;
      timer.stop(upstreamStatus, 'success');

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

      if (err instanceof DOMException && err.name === 'TimeoutError') {
        upstreamStatus = 504;
        outcome = 'timeout';
        res.set('x-request-id', requestId);
        res.status(504).json({ error: 'Gateway Timeout', requestId });
      } else if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'UND_ERR_CONNECT_TIMEOUT') {
        upstreamStatus = 504;
        outcome = 'timeout';
        res.set('x-request-id', requestId);
        res.status(504).json({ error: 'Gateway Timeout', requestId });
      } else {
        upstreamStatus = 502;
        res.set('x-request-id', requestId);
        res.status(502).json({ error: 'Bad Gateway: upstream unreachable', requestId });
      }

      timer.stop(upstreamStatus, outcome);
    }

    // 8. Record usage & deduct billing (Non-blocking background task)
    if (config.recordableStatuses(upstreamStatus)) {
      setImmediate(() => {
        const recorded = usageStore.record({
          id: randomUUID(), // ID of the usage event itself
          requestId,        // Idempotency key
          apiKey: apiKeyHeader,
          apiKeyId: keyRecord.id,
          apiId: String(apiEntry.id),
          endpointId: endpoint.endpointId,
          userId: keyRecord.userId,
          amountUsdc: endpoint.priceUsdc,
          statusCode: upstreamStatus,
          timestamp: new Date().toISOString(),
        });

        // Only deduct billing if we haven't processed this requestId before
        if (recorded && endpoint.priceUsdc > 0) {
          billing.deductCredit(keyRecord.userId, endpoint.priceUsdc).catch((err) => {
            console.error('Background billing deduction failed:', err);
          });
        }
      });
    }
  }

  return router;
}
