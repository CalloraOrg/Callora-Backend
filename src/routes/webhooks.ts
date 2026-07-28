import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { validateWebhookUrl, WebhookValidationError } from '../webhooks/webhook.validator.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import { WebhookEventType, type RetryPolicy } from '../webhooks/webhook.types.js';
import {
  captureRawBody,
  verifyWebhookSignature,
} from '../webhooks/webhook.signature.js';
import { AppError, BadRequestError, NotFoundError } from '../errors/index.js';
import { createRestRateLimitMiddleware } from '../middleware/restRateLimit.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { validateRetryPolicy } from '../services/webhookRetry.js';
import { appendAuditRow } from '../services/auditService.js';

const router = Router();

const webhookMgmtRateLimit = createRestRateLimitMiddleware(config.webhookRateLimit);

const VALID_EVENTS: WebhookEventType[] = [
  'new_api_call',
  'settlement_completed',
  'low_balance_alert',
];

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function sanitizeConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!config) return null;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'secret' || key === 'secret_current' || key === 'secret_previous') {
      sanitized[key] = maskSecret(typeof value === 'string' ? value : undefined);
    } else if (key === 'previous_expires_at' && value instanceof Date) {
      sanitized[key] = value.toISOString();
    } else if (typeof value === 'function') {
      sanitized[key] = '[Function]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

async function auditStateChange(
  req: Request,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  const actor = req.params.developerId ?? req.body.developerId;
  const auditContext = (req as Request & { auditContext?: unknown }).auditContext as
    | { clientIp?: string; userAgent?: string; correlationId?: string; bodyHash?: string; tenantId?: string | null }
    | undefined;

  try {
    await appendAuditRow({
      actor,
      action,
      before,
      after,
      tenantId: auditContext?.tenantId ?? null,
      correlationId: auditContext?.correlationId ?? null,
      clientIp: auditContext?.clientIp ?? null,
      userAgent: auditContext?.userAgent ?? null,
      bodyHash: auditContext?.bodyHash ?? null,
    });
  } catch (err) {
    logger.error('Failed to persist audit row', { error: err, action, actor });
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

    const before = WebhookStore.get(developerId) ? sanitizeConfig(WebhookStore.get(developerId) as unknown as Record<string, unknown>) : null;

    WebhookStore.register({
      developerId,
      url,
      events: events as WebhookEventType[],
      secret_current: secret ?? undefined,
      retryPolicy: retryPolicy as RetryPolicy | undefined,
      createdAt: new Date(),
    });

    const after = sanitizeConfig(WebhookStore.get(developerId) as unknown as Record<string, unknown>);

    await auditStateChange(req, 'WEBHOOK_REGISTERED', before, after);

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

  const before = sanitizeConfig(existing as unknown as Record<string, unknown>);

  const newSecret = generateWebhookSecret();
  const previousExpiresAt = new Date(Date.now() + config.webhooks.secretRotationGraceMs);
  const rotated = WebhookStore.rotateSecret(req.params.developerId, newSecret, previousExpiresAt);

  if (!rotated) {
    throw new NotFoundError(
      'No webhook registered for this developer.',
      'WEBHOOK_NOT_FOUND'
    );
  }

  const after = sanitizeConfig(rotated as unknown as Record<string, unknown>);

  logger.audit('WEBHOOK_SECRET_ROTATED', req.params.developerId, {
    developerId: req.params.developerId,
    previousExpiresAt: rotated.previous_expires_at?.toISOString(),
    hadPreviousSecret: Boolean(existing.secret_current ?? existing.secret),
  });

  void auditStateChange(req, 'WEBHOOK_SECRET_ROTATED', before, after);

  return res.status(200).json({
    message: 'Webhook secret rotated successfully.',
    developerId: req.params.developerId,
    secret: newSecret,
    previous_expires_at: rotated.previous_expires_at?.toISOString(),
  });
});

// DELETE /api/webhooks/:developerId — Remove webhook
router.delete('/:developerId', webhookMgmtRateLimit, async (req: Request, res: Response) => {
const existing = WebhookStore.get(req.params.developerId);
  const before = existing ? sanitizeConfig(existing as unknown as Record<string, unknown>) : null;

  WebhookStore.delete(req.params.developerId);

  await auditStateChange(req, 'WEBHOOK_DELETED', before, null);

  return res.json({ message: 'Webhook removed.' });
});

// PATCH /api/webhooks/:developerId/retry-policy — Update retry policy for subscription
router.patch('/:developerId/retry-policy', webhookMgmtRateLimit, (req: Request, res: Response, next: NextFunction) => {
  try {
    const { retryPolicy } = req.body;

    const validation = validateRetryPolicy(retryPolicy);
    if (!validation.valid) {
      throw new BadRequestError(
        validation.error!,
        'INVALID_RETRY_POLICY'
      );
    }

    const existing = WebhookStore.get(req.params.developerId);
    const before = existing ? { retryPolicy: (existing as unknown as Record<string, unknown>).retryPolicy } : null;

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

    const after = { retryPolicy: updated.retryPolicy };

    logger.audit('WEBHOOK_RETRY_POLICY_UPDATED', req.params.developerId, {
      developerId: req.params.developerId,
      retryPolicy: updated.retryPolicy,
    });

    void auditStateChange(req, 'WEBHOOK_RETRY_POLICY_UPDATED', before, after);

    const {
      secret: _s,
      secret_current: _sc,
      secret_previous: _sp,
      ...safeConfig
    } = updated;

    return res.status(200).json({
      message: 'Webhook retry policy updated successfully.',
      ...safeConfig,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/deliver/:developerId',
  captureRawBody,
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
    return res.status(200).json({ message: 'Webhook delivery accepted.', body: req.body });
  }
);

export function createWebhooksRouter(): Router {
  return router;
}

export default router;