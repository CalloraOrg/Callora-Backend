import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { validateWebhookUrl, WebhookValidationError } from './webhook.validator.js';
import { WebhookStore } from './webhook.store.js';
import { WebhookEventType } from './webhook.types.js';
import {
  captureRawBody,
  verifyWebhookSignature,
} from './webhook.signature.js';
import { AppError, BadRequestError, NotFoundError } from '../errors/index.js';
import { createRestRateLimitMiddleware } from '../middleware/restRateLimit.js';
import { config } from '../config/index.js';

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

// POST /api/webhooks — Register a webhook
router.post('/', webhookMgmtRateLimit, express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId, url, events, secret } = req.body;

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

    WebhookStore.register({
      developerId,
      url,
      events: events as WebhookEventType[],
      secret: secret ?? undefined,
      createdAt: new Date(),
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
  const { secret: _s, ...safeConfig } = config;
  return res.json(safeConfig);
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
  (req: Request & { webhookSecret?: string }, res: Response, next) => {
    const config = WebhookStore.get(req.params.developerId);
    if (!config) {
      next(new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      ));
      return;
    }
    req.webhookSecret = config.secret;
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
