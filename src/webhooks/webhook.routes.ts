import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { validateRetryPolicy, validateWebhookUrl, WebhookValidationError } from './webhook.validator.js';
import { WebhookStore } from './webhook.store.js';
import { WebhookConfig, WebhookEventType } from './webhook.types.js';
import {
  captureRawBody,
  verifyWebhookSignature,
} from './webhook.signature.js';
import { AppError, BadRequestError, NotFoundError } from '../errors/index.js';
import { createRestRateLimitMiddleware } from '../middleware/restRateLimit.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

const router = Router();

/**
 * Rate limiter for webhook management routes (POST /, GET /:id, DELETE /:id).
 * Keys on client IP (unauthenticated routes). Window and max are configurable
 * via WEBHOOK_RATE_LIMIT_WINDOW_MS / WEBHOOK_RATE_LIMIT_MAX_REQUESTS, falling
 * back to the global REST rate-limit settings.
 */
const webhookMgmtRateLimit = createRestRateLimitMiddleware(config.webhookRateLimit);

const VALID_EVENTS: WebhookEventType[] = [
  'new_api_call',
  'settlement_completed',
  'low_balance_alert',
];

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function validateRetryPolicyOverride(retryPolicy: unknown): Promise<WebhookConfig['retryPolicy']> {
  try {
    return validateRetryPolicy(retryPolicy);
  } catch (err: unknown) {
    if (err instanceof WebhookValidationError) {
      throw new BadRequestError(err.message, 'INVALID_WEBHOOK_RETRY_POLICY');
    }
    throw new AppError('Retry policy validation failed.', 500, 'WEBHOOK_URL_VALIDATION_FAILED');
  }
}

// POST /api/webhooks — Register a webhook
router.post('/', webhookMgmtRateLimit, express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId, url, events, secret, retryPolicy } = req.body;

    if (!developerId || !url || !Array.isArray(events) || events.length === 0) {
      throw new BadRequestError(
        'developerId, url, and a non-empty events array are required.',
        'INVALID_WEBHOOK_REGISTRATION'
      );
    }

    const invalidEvents = events.filter(
      (e: string) => !VALID_EVENTS.includes(e as WebhookEventType)
    );
    if (invalidEvents.length > 0) {
      throw new BadRequestError(
        `Invalid event types: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`,
        'INVALID_WEBHOOK_EVENT_TYPES'
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

    let validatedRetryPolicy: WebhookConfig['retryPolicy'];
    if (retryPolicy !== undefined) {
      validatedRetryPolicy = await validateRetryPolicyOverride(retryPolicy);
    }

    WebhookStore.register({
      developerId,
      url,
      events: events as WebhookEventType[],
      secret: secret ?? undefined,
      secret_current: secret ?? undefined,
      retryPolicy: validatedRetryPolicy,
      createdAt: new Date(),
    });

    res.status(201).json({
      message: 'Webhook registered successfully.',
      developerId,
      url,
      events,
      retryPolicy: validatedRetryPolicy,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/webhooks/:developerId — Update webhook subscription settings
router.patch('/:developerId', webhookMgmtRateLimit, express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = WebhookStore.get(req.params.developerId);
    if (!existing) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const { url, events, secret, retryPolicy } = req.body;
    const changes: Partial<WebhookConfig> = {};

    if (url !== undefined) {
      try {
        await validateWebhookUrl(url);
      } catch (err: unknown) {
        if (err instanceof WebhookValidationError) {
          throw new BadRequestError(err.message, 'INVALID_WEBHOOK_URL');
        }

        throw new AppError('URL validation failed.', 500, 'WEBHOOK_URL_VALIDATION_FAILED');
      }
      changes.url = url;
    }

    if (events !== undefined) {
      if (!Array.isArray(events) || events.length === 0) {
        throw new BadRequestError('events must be a non-empty array when provided.', 'INVALID_WEBHOOK_REGISTRATION');
      }

      const invalidEvents = events.filter(
        (e: string) => !VALID_EVENTS.includes(e as WebhookEventType)
      );
      if (invalidEvents.length > 0) {
        throw new BadRequestError(
          `Invalid event types: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`,
          'INVALID_WEBHOOK_EVENT_TYPES'
        );
      }

      changes.events = events as WebhookEventType[];
    }

    if (secret !== undefined) {
      changes.secret = secret;
      changes.secret_current = secret;
      changes.secret_previous = undefined;
      changes.previous_expires_at = undefined;
    }

    if (retryPolicy !== undefined) {
      changes.retryPolicy = retryPolicy === null ? undefined : await validateRetryPolicyOverride(retryPolicy);
    }

    const updated = WebhookStore.update(req.params.developerId, changes);
    if (!updated) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const {
      secret: _s,
      secret_current: _sc,
      secret_previous: _sp,
      ...safeConfig
    } = updated;

    return res.status(200).json(safeConfig);
  } catch (error) {
    next(error);
  }
});

// GET /api/webhooks/:developerId — Get webhook config
router.get('/:developerId', webhookMgmtRateLimit, (req: Request, res: Response) => {
  const config = WebhookStore.get(req.params.developerId);
  if (!config) {
    throw new NotFoundError(
      'No webhook registered for this developer.',
      'WEBHOOK_NOT_FOUND'
    );
  }
  // Never expose the secret
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    secret: _s,
    secret_current: _sc,
    secret_previous: _sp,
    ...safeConfig
  } = config;
  return res.json(safeConfig);
});

// POST /api/webhooks/:developerId/rotate-secret — Rotate webhook signing secret
router.post('/:developerId/rotate-secret', webhookMgmtRateLimit, (req: Request, res: Response) => {
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

// DELETE /api/webhooks/:developerId — Remove webhook
router.delete('/:developerId', webhookMgmtRateLimit, (req: Request, res: Response) => {
  WebhookStore.delete(req.params.developerId);
  return res.json({ message: 'Webhook removed.' });
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
  (req: Request, res: Response) => {
    // Payload has been verified — safe to process
    return res.status(200).json({ message: 'Webhook delivery accepted.', body: req.body });
  }
);

export default router;
