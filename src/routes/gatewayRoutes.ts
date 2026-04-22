import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { startUpstreamTimer, type UpstreamOutcome } from '../metrics.js';
import { validate } from '../middleware/validate.js';
import type { GatewayDeps } from '../types/gateway.js';

const CREDIT_COST_PER_CALL = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_SIZE = '1mb';

const apiIdParamsSchema = z.object({
  apiId: z.string().min(1, 'API ID is required').max(50, 'API ID too long'),
});

export function createGatewayRouter(deps: GatewayDeps): Router {
  const { billing, rateLimiter, usageStore, upstreamUrl } = deps;
  const apiKeys = deps.apiKeys ?? new Map();
  const maxBodySize = deps.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const router = Router();

  // Enforce body size limits at the router level so the gateway is self-contained
  // regardless of whether a global body parser is present. Oversized bodies surface
  // as 413 via the app-level error handler.
  router.use(express.json({ limit: maxBodySize }));
  router.use(express.urlencoded({ extended: false, limit: maxBodySize }));

  router.all(
    '/:apiId',
    validate({ params: apiIdParamsSchema }),
    async (req: Request, res: Response) => {
      const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
      const requestId = randomUUID();

      if (!apiKeyHeader) {
        res.status(401).json({
          error: 'Unauthorized: missing x-api-key header',
          requestId,
        });
        return;
      }

      const keyRecord = apiKeys.get(apiKeyHeader);
      if (!keyRecord || keyRecord.apiId !== req.params.apiId) {
        res.status(401).json({
          error: 'Unauthorized: invalid API key',
          requestId,
        });
        return;
      }

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

      const billingResult = await billing.deductCredit(
        keyRecord.developerId,
        CREDIT_COST_PER_CALL,
      );
      if (!billingResult.success) {
        res.status(402).json({
          error: 'Payment Required: insufficient balance',
          balance: billingResult.balance,
          requestId,
        });
        return;
      }

      let upstreamStatus = 502;
      let upstreamBody = JSON.stringify({ error: 'Bad Gateway: upstream unreachable', requestId });
      let upstreamContentType = 'application/json; charset=utf-8';
      let outcome: UpstreamOutcome = 'error';
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
      } catch (error) {
        if (
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          (error instanceof TypeError &&
            (error as NodeJS.ErrnoException).code === 'UND_ERR_CONNECT_TIMEOUT')
        ) {
          upstreamStatus = 504;
          upstreamBody = JSON.stringify({ error: 'Gateway Timeout', requestId });
          upstreamContentType = 'application/json; charset=utf-8';
          outcome = 'timeout';
        }
      } finally {
        timer.stop(upstreamStatus, outcome);
      }

      usageStore.record({
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
    },
  );

  return router;
}
