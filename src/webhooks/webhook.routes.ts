import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { validateWebhookUrl, WebhookValidationError } from './webhook.validator.js';
import { WebhookStore } from './webhook.store.js';
import { WebhookEventType, type RetryPolicy } from './webhook.types.js';
import {
  captureRawBody,
  verifyWebhookSignature,
} from './webhook.signature.js';
import { AppError, BadRequestError, NotFoundError } from '../errors/index.js';
import { createRestRateLimitMiddleware } from '../middleware/restRateLimit.js';
import { createWebhookAccessLogMiddleware } from '../middleware/webhookAccessLog.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { validateRetryPolicy } from '../services/webhookRetry.js';
import { createWebhookHealthRouter } from '../routes/webhooks/health.js';
import { securityHeadersMiddleware } from '../middleware/securityHeaders.js';
import { validate } from '../middleware/validate.js';
import {
  registerWebhookSchema,
  updateWebhookRetryPolicySchema,
  webhookDeliveryPayloadSchema,
  webhookDeveloperParamsSchema,
} from '../validators/webhooks.js';

const router = Router();

// Apply security header sweep middleware to all webhook routes
router.use(securityHeadersMiddleware);

/**
 * Structured access log middleware scoped to webhook routes.
 * Includes req-id, latency, status, size, and actor (developerId from route params).
 */
const webhookAccessLog = createWebhookAccessLogMiddleware();

// Apply access logging to all webhook routes
router.use(webhookAccessLog);

/**
 * Rate limiter for webhook management routes (POST /, GET /:id, DELETE /:id).
 * Keys on client IP (unauthenticated routes). Window and max are configurable
 * via WEBHOOK_RATE_LIMIT_WINDOW_MS / WEBHOOK_RATE_LIMIT_MAX_REQUESTS, falling
 * back to the global REST rate-limit settings.
 */
const webhookMgmtRateLimit = createRestRateLimitMiddleware(config.webhookRateLimit);

// Mount the webhook subsystem health probe at /health.
// This must be registered BEFORE the parameterised /:developerId routes so
// the literal path segment "health" is not captured as a developerId.
router.use('/health', createWebhookHealthRouter());

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function requestId(req: Request): string {
  return req.id || 'unknown';
}

function correlationId(req: Request): string {
  return req.header('x-correlation-id') || requestId(req);
}

// POST /api/webhooks — Register a webhook
router.post('/', webhookMgmtRateLimit, express.json(), validate({ body: registerWebhookSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId, url, events, secret, retryPolicy } = registerWebhookSchema.parse(req.body);

    const validation = validateRetryPolicy(retryPolicy);
    if (!validation.valid) {
      throw new BadRequestError(
        validation.error!,
        'INVALID_RETRY_POLICY'
      );
    }

    try {
      await validateWebhookUrl(url);
    } catch (err: unknown) {
      if (err instanceof WebhookValidationError) {
        throw new BadRequestError(err.message, 'INVALID_WEBHOOK_URL');
      }

      throw new AppError('URL validation failed.', 500, 'WEBHOOK_URL_VALIDATION_FAILED');
    }

    WebhookStore.register({
      developerId,
      url,
      events: events as WebhookEventType[],
      secret_current: secret ?? undefined,
      retryPolicy: retryPolicy as RetryPolicy | undefined,
      createdAt: new Date(),
    });

    logger.info('[webhooks] webhook registered', {
      requestId: requestId(req),
      correlationId: correlationId(req),
      developerId,
      events,
      hasSecret: Boolean(secret),
      retryPolicyConfigured: Boolean(retryPolicy),
    });

    res.status(201).json({
      message: 'Webhook registered successfully.',
      developerId,
      url,
      events,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/webhooks/:developerId — Get webhook config
router.get('/:developerId', webhookMgmtRateLimit, validate({ params: webhookDeveloperParamsSchema }), (req: Request, res: Response) => {
  const config = WebhookStore.get(req.params.developerId);
  if (!config) {
    throw new NotFoundError(
      'No webhook registered for this developer.',
      'WEBHOOK_NOT_FOUND'
    );
  }
  // Never expose the secret
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, secret_current, secret_previous, ...safeConfig } = config;
  return res.json(safeConfig);
});

// POST /api/webhooks/:developerId/rotate-secret — Rotate webhook signing secret
router.post('/:developerId/rotate-secret', webhookMgmtRateLimit, validate({ params: webhookDeveloperParamsSchema }), (req: Request, res: Response) => {
  const existing = WebhookStore.get(req.params.developerId);
  if (!existing) {
    throw new NotFoundError(
      'No webhook registered for this developer.',
      'WEBHOOK_NOT_FOUND'
    );
  }

  const newSecret = generateWebhookSecret();
  const previousExpiresAt = new Date(Date.now() + config.webhooks.secretRotationGraceMs);
  const rotated = WebhookStore.rotateSecret(req.params.developerId, newSecret, previousExpiresAt);

  if (!rotated) {
    throw new NotFoundError(
      'No webhook registered for this developer.',
      'WEBHOOK_NOT_FOUND'
    );
  }

  logger.audit('WEBHOOK_SECRET_ROTATED', req.params.developerId, {
    developerId: req.params.developerId,
    correlationId: correlationId(req),
    previousExpiresAt: rotated.previous_expires_at?.toISOString(),
    hadPreviousSecret: Boolean(existing.secret_current ?? existing.secret),
  });

  return res.status(200).json({
    message: 'Webhook secret rotated successfully.',
    developerId: req.params.developerId,
    secret: newSecret,
    previous_expires_at: rotated.previous_expires_at?.toISOString(),
  });
});

// POST /api/webhooks/:developerId/delete-token — Issue confirmation token for two-step delete
router.post('/:developerId/delete-token', webhookMgmtRateLimit, validate({ params: webhookDeveloperParamsSchema }), (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = WebhookStore.get(req.params.developerId);
    if (!existing) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const tokenEntry = WebhookStore.issueDeleteToken(req.params.developerId);
    if (!tokenEntry) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const expiresInMs = tokenEntry.expiresAt.getTime() - Date.now();

    logger.audit('WEBHOOK_DELETE_TOKEN_ISSUED', req.params.developerId, {
      developerId: req.params.developerId,
      correlationId: correlationId(req),
      expiresAt: tokenEntry.expiresAt.toISOString(),
    });

    logger.info('[webhooks] deletion token issued', {
      requestId: requestId(req),
      correlationId: correlationId(req),
      developerId: req.params.developerId,
      expiresAt: tokenEntry.expiresAt.toISOString(),
    });

    return res.status(200).json({
      message: 'Webhook deletion confirmation token issued.',
      developerId: req.params.developerId,
      token: tokenEntry.token,
      expires_at: tokenEntry.expiresAt.toISOString(),
      expiresInMs,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/webhooks/:developerId — Remove webhook (two-step delete with confirmation token)
router.delete('/:developerId', webhookMgmtRateLimit, express.json(), validate({ params: webhookDeveloperParamsSchema }), (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = WebhookStore.get(req.params.developerId);
    if (!existing) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const rawToken =
      req.query.token ??
      req.query.confirmationToken ??
      req.query.confirmation_token ??
      req.header('x-confirm-token') ??
      req.header('x-callora-delete-token') ??
      req.header('x-confirmation-token') ??
      (typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>).token ??
          (req.body as Record<string, unknown>).confirmationToken ??
          (req.body as Record<string, unknown>).confirmation_token
        : undefined);

    const tokenString = typeof rawToken === 'string' ? rawToken.trim() : '';

    const verification = WebhookStore.verifyDeleteToken(req.params.developerId, tokenString);
    if (!verification.valid) {
      if (verification.error === 'MISSING_TOKEN') {
        throw new BadRequestError(
          'A confirmation token is required to delete a webhook subscription. Request a token via POST /api/webhooks/:developerId/delete-token.',
          'MISSING_TOKEN'
        );
      }
      if (verification.error === 'EXPIRED_TOKEN') {
        throw new BadRequestError(
          'The confirmation token has expired. Please request a new token via POST /api/webhooks/:developerId/delete-token.',
          'EXPIRED_TOKEN'
        );
      }
      throw new BadRequestError(
        'Invalid confirmation token provided for webhook deletion.',
        'INVALID_TOKEN'
      );
    }

    const result = WebhookStore.deleteSubscriptionWithCleanup(req.params.developerId, tokenString);

    logger.info('[webhooks] webhook removed', {
      requestId: requestId(req),
      correlationId: correlationId(req),
      developerId: req.params.developerId,
      prunedDeliveryAttempts: result.prunedDeliveryAttempts,
    });

    logger.audit('WEBHOOK_DELETED', req.params.developerId, {
      developerId: req.params.developerId,
      correlationId: correlationId(req),
      prunedDeliveryAttempts: result.prunedDeliveryAttempts,
    });

    return res.status(200).json({
      message: 'Webhook removed.',
      developerId: req.params.developerId,
      prunedDeliveryAttempts: result.prunedDeliveryAttempts,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/webhooks/:developerId/retry-policy — Update retry policy for subscription
router.patch('/:developerId/retry-policy', webhookMgmtRateLimit, express.json(), validate({ params: webhookDeveloperParamsSchema, body: updateWebhookRetryPolicySchema }), (req: Request, res: Response, next: NextFunction) => {
  try {
    const { retryPolicy } = updateWebhookRetryPolicySchema.parse(req.body);

    const validation = validateRetryPolicy(retryPolicy);
    if (!validation.valid) {
      throw new BadRequestError(
        validation.error!,
        'INVALID_RETRY_POLICY'
      );
    }

    const updated = WebhookStore.updateRetryPolicy(
      req.params.developerId,
      retryPolicy as RetryPolicy | undefined
    );

    if (!updated) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    logger.audit('WEBHOOK_RETRY_POLICY_UPDATED', req.params.developerId, {
      developerId: req.params.developerId,
      correlationId: correlationId(req),
      retryPolicy: updated.retryPolicy,
    });

    // Never expose the secret
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { secret, secret_current, secret_previous, ...safeConfig } = updated;

    return res.status(200).json({
      message: 'Webhook retry policy updated successfully.',
      ...safeConfig,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/webhooks/deliver/:developerId
 *
 * Inbound delivery endpoint — receives a signed webhook event sent by an
 * external system and verifies the HMAC-SHA256 signature before processing.
 *
 * Middleware chain:
 *   1. captureRawBody  — buffers raw bytes before express.json() consumes the stream
 *   2. lookupSecret    — attaches req.webhookSecret from the developer's stored config
 *   3. verifyWebhookSignature — enforces HMAC + replay-window check
 *   4. express.json()  — parses the verified body for the handler
 */
router.post(
  '/deliver/:developerId',
  validate({ params: webhookDeveloperParamsSchema }),
  captureRawBody,
  // Attach the stored secret so verifyWebhookSignature can read it
  (req: Request & { webhookSecrets?: string[] }, res: Response, next) => {
    const config = WebhookStore.get(req.params.developerId);
    if (!config) {
      next(new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      ));
      return;
    }
    req.webhookSecrets = WebhookStore.getActiveSecrets(config);
    next();
  },
  verifyWebhookSignature,
  express.json(),
  validate({ body: webhookDeliveryPayloadSchema }),
  (req: Request, res: Response) => {
    // Payload has been verified — safe to process
    return res.status(200).json({ message: 'Webhook delivery accepted.', body: req.body });
  }
);

export default router;
