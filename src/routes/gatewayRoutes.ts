import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { GatewayDeps } from '../types/gateway.js';

const CREDIT_COST_PER_CALL = 1; // cost per proxied request

/**
 * Factory that creates the gateway router with injected dependencies.
 * This makes the router fully testable with mocked services.
 */
export function createGatewayRouter(deps: GatewayDeps): Router {
  const { billing, rateLimiter, usageStore, upstreamUrl, apiKeys } = deps;
  const router = Router();

  /**
   * POST /api/gateway/:apiId
   *
   * Proxy flow:
   *   1. Validate API key from x-api-key header
   *   2. Rate-limit check
   *   3. Billing deduction (Soroban)
   *   4. Proxy request to upstream
   *   5. Record usage event
   *   6. Return upstream response
   */
  router.all('/:apiId', async (req: Request, res: Response) => {
    // 1. Validate API key
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    if (!apiKeyHeader) {
      res.status(401).json({ error: 'Unauthorized: missing x-api-key header' });
      return;
    }

    const keyRecord = apiKeys.get(apiKeyHeader);
    if (!keyRecord || keyRecord.apiId !== req.params.apiId) {
      res.status(401).json({ error: 'Unauthorized: invalid API key' });
      return;
    }

    // 2. Rate-limit check
    const rateResult = rateLimiter.check(apiKeyHeader);
    if (!rateResult.allowed) {
      const retryAfterSec = Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'Too Many Requests', retryAfterMs: rateResult.retryAfterMs });
      return;
    }

    // 3. Billing deduction
    const billingResult = await billing.deductCredit(
      keyRecord.developerId,
      CREDIT_COST_PER_CALL,
    );
    if (!billingResult.success) {
      res.status(402).json({
        error: 'Payment Required: insufficient balance',
        balance: billingResult.balance,
      });
      return;
    }

    // 4. Proxy to upstream
    let upstreamStatus = 502;
    let upstreamBody: string = '{"error":"Bad Gateway"}';

    try {
      const upstreamRes = await fetch(`${upstreamUrl}${req.path}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });

      upstreamStatus = upstreamRes.status;
      upstreamBody = await upstreamRes.text();
    } catch {
      upstreamStatus = 502;
      upstreamBody = JSON.stringify({ error: 'Bad Gateway: upstream unreachable' });
    }

    // 5. Record usage event
    usageStore.record({
      id: randomUUID(),
      requestId: randomUUID(), // legacy gateway doesn't carry request ID
      apiKey: apiKeyHeader,
      apiKeyId: keyRecord.key,
      apiId: keyRecord.apiId,
      endpointId: 'legacy',
      userId: keyRecord.developerId,
      amountUsdc: CREDIT_COST_PER_CALL,
      statusCode: upstreamStatus,
      timestamp: new Date().toISOString(),
    });

    // 6. Return upstream response
    res.status(upstreamStatus);
    try {
      res.json(JSON.parse(upstreamBody));
    } catch {
      res.send(upstreamBody);
    }
  });

  return router;
}
