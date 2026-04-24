import { Router, Request, Response } from 'express';
import express from 'express';
import { validateWebhookUrl, WebhookValidationError } from './webhook.validator.js';
import { WebhookStore } from './webhook.store.js';
import { WebhookEventType } from './webhook.types.js';
import {
  captureRawBody,
  verifyWebhookSignature,
} from './webhook.signature.js';

const router = Router();

const VALID_EVENTS: WebhookEventType[] = [
  'new_api_call',
  'settlement_completed',
  'low_balance_alert',
];

// POST /api/webhooks — Register a webhook
router.post('/', express.json(), async (req: Request, res: Response) => {
  const { developerId, url, events, secret } = req.body;

  if (!developerId || !url || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({
      error: 'developerId, url, and a non-empty events array are required.',
    });
  }

  const invalidEvents = events.filter(
    (e: string) => !VALID_EVENTS.includes(e as WebhookEventType)
  );
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error: `Invalid event types: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`,
    });
  }

  try {
    await validateWebhookUrl(url);
  } catch (err: unknown) {
    if (err instanceof WebhookValidationError) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: 'URL validation failed.' });
  }

  WebhookStore.register({
    developerId,
    url,
    events: events as WebhookEventType[],
    secret: secret ?? undefined,
    createdAt: new Date(),
  });

  return res.status(201).json({
    message: 'Webhook registered successfully.',
    developerId,
    url,
    events,
  });
});

// GET /api/webhooks/:developerId — Get webhook config
router.get('/:developerId', (req: Request, res: Response) => {
  const config = WebhookStore.get(req.params.developerId);
  if (!config) {
    return res.status(404).json({ error: 'No webhook registered for this developer.' });
  }
  // Never expose the secret
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret: _s, ...safeConfig } = config;
  return res.json(safeConfig);
});

// DELETE /api/webhooks/:developerId — Remove webhook
router.delete('/:developerId', (req: Request, res: Response) => {
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
      return res.status(404).json({ error: 'No webhook registered for this developer.' });
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