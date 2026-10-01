import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { validateWebhookUrl, WebhookValidationError } from '../webhooks/webhook.validator.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import { WebhookEventType, type RetryPolicy } from '../webhooks/webhook.types.js';
import {
  captureRawBody,
  verifyWebhookSignature,
  parseCapturedJson,
} from '../webhooks/webhook.signature.js';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../errors/index.js';
import { createRestRateLimitMiddleware } from '../middleware/restRateLimit.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { validateRetryPolicy } from '../services/webhookRetry.js';
import { appendAuditRow } from '../services/auditService.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { securityHeadersMiddleware } from '../middleware/securityHeaders.js';

const router = Router();

// Apply security header sweep middleware to all webhook routes
router.use(securityHeadersMiddleware);

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

function getAuthenticatedActor(res: Response): string | undefined {
  if (res.locals.adminActor) {
    return res.locals.adminActor;
  }
  return res.locals.authenticatedUser?.id;
}

function isAuthorizedForDeveloper(res: Response, targetDeveloperId: string): boolean {
  if (res.locals.adminActor) {
    return true;
  }
  const authenticatedUserId = res.locals.authenticatedUser?.id;
  return Boolean(authenticatedUserId && authenticatedUserId === targetDeveloperId);
}

function webhookAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header('x-admin-api-key');
  if (apiKey) {
    adminAuth(req, res, next);
    return;
  }

  requireAuth(req, res, (err) => {
    if (err) {
      const authHeader = req.header('authorization') || req.header('Authorization');
      if (authHeader?.startsWith('Bearer ')) {
        adminAuth(req, res, (adminErr) => {
          if (!adminErr && res.locals.adminActor) {
            next();
            return;
          }
          next(err);
        });
        return;
      }
      next(err);
      return;
    }

    const authHeader = req.header('authorization') || req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const secret = process.env.JWT_SECRET || config.jwt?.secret;
      if (secret) {
        try {
          const decoded = jwt.verify(token, secret) as { role?: string; sub?: string; email?: string };
          if (decoded && decoded.role === 'admin') {
            res.locals.adminActor = decoded.sub || decoded.email || 'admin-jwt';
          }
        } catch {
          // Ignore, standard user auth already succeeded
        }
      }
    }

    next();
  });
}

async function auditStateChange(
  req: Request,
  res: Response,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  const actor = getAuthenticatedActor(res) ?? req.params.developerId ?? req.body?.developerId ?? 'unknown';
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

// Protect all management endpoints with authentication (excluding /deliver)
router.use((req: Request, res: Response, next: NextFunction) => {
  const isDelivery = req.path.includes('/deliver/') || req.path.endsWith('/deliver');
  if (isDelivery) {
    next();
    return;
  }
  webhookAuth(req, res, next);
});

// POST /api/webhooks — Register a webhook
router.post('/', webhookMgmtRateLimit, express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authenticatedUserId = res.locals.authenticatedUser?.id;
    const targetDeveloperId = req.body?.developerId ?? authenticatedUserId;

    if (!targetDeveloperId) {
      throw new BadRequestError(
        'developerId, url, and a non-empty events array are required.',
        'INVALID_WEBHOOK_REGISTRATION'
      );
    }

    if (!isAuthorizedForDeveloper(res, targetDeveloperId)) {
      throw new ForbiddenError(
        'Cannot register webhook for another developer.',
        'FORBIDDEN'
      );
    }

    const developerId = res.locals.adminActor ? targetDeveloperId : (authenticatedUserId ?? targetDeveloperId);

    const { url, events, secret, retryPolicy } = req.body;

    if (!url || !Array.isArray(events) || events.length === 0) {
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

    await auditStateChange(req, res, 'WEBHOOK_REGISTERED', before, after);

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
router.get('/:developerId', webhookMgmtRateLimit, (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId } = req.params;
    if (!isAuthorizedForDeveloper(res, developerId)) {
      throw new ForbiddenError(
        'Cannot view webhook for another developer.',
        'FORBIDDEN'
      );
    }

    const config = WebhookStore.get(developerId);
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
  } catch (error) {
    next(error);
  }
});

// POST /api/webhooks/:developerId/rotate-secret — Rotate webhook signing secret
router.post('/:developerId/rotate-secret', webhookMgmtRateLimit, (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId } = req.params;
    if (!isAuthorizedForDeveloper(res, developerId)) {
      throw new ForbiddenError(
        'Cannot rotate secret for another developer.',
        'FORBIDDEN'
      );
    }

    const existing = WebhookStore.get(developerId);
    if (!existing) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const before = sanitizeConfig(existing as unknown as Record<string, unknown>);

    const newSecret = generateWebhookSecret();
    const previousExpiresAt = new Date(Date.now() + config.webhooks.secretRotationGraceMs);
    const rotated = WebhookStore.rotateSecret(developerId, newSecret, previousExpiresAt);

    if (!rotated) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const after = sanitizeConfig(rotated as unknown as Record<string, unknown>);
    const actor = getAuthenticatedActor(res) ?? developerId;

    logger.audit('WEBHOOK_SECRET_ROTATED', actor, {
      developerId,
      actor,
      previousExpiresAt: rotated.previous_expires_at?.toISOString(),
      hadPreviousSecret: Boolean(existing.secret_current ?? existing.secret),
    });

    void auditStateChange(req, res, 'WEBHOOK_SECRET_ROTATED', before, after);

    return res.status(200).json({
      message: 'Webhook secret rotated successfully.',
      developerId,
      secret: newSecret,
      previous_expires_at: rotated.previous_expires_at?.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/webhooks/:developerId — Remove webhook
router.delete('/:developerId', webhookMgmtRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId } = req.params;
    if (!isAuthorizedForDeveloper(res, developerId)) {
      throw new ForbiddenError(
        'Cannot delete webhook for another developer.',
        'FORBIDDEN'
      );
    }

    const existing = WebhookStore.get(developerId);
    const before = existing ? sanitizeConfig(existing as unknown as Record<string, unknown>) : null;

    WebhookStore.delete(developerId);

    await auditStateChange(req, res, 'WEBHOOK_DELETED', before, null);

    return res.json({ message: 'Webhook removed.' });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/webhooks/:developerId/retry-policy — Update retry policy for subscription
router.patch('/:developerId/retry-policy', webhookMgmtRateLimit, express.json(), (req: Request, res: Response, next: NextFunction) => {
  try {
    const { developerId } = req.params;
    if (!isAuthorizedForDeveloper(res, developerId)) {
      throw new ForbiddenError(
        'Cannot update retry policy for another developer.',
        'FORBIDDEN'
      );
    }

    const { retryPolicy } = req.body;

    const validation = validateRetryPolicy(retryPolicy);
    if (!validation.valid) {
      throw new BadRequestError(
        validation.error!,
        'INVALID_RETRY_POLICY'
      );
    }

    const existing = WebhookStore.get(developerId);
    const before = existing ? { retryPolicy: (existing as unknown as Record<string, unknown>).retryPolicy } : null;

    const updated = WebhookStore.updateRetryPolicy(
      developerId,
      retryPolicy as RetryPolicy | undefined
    );

    if (!updated) {
      throw new NotFoundError(
        'No webhook registered for this developer.',
        'WEBHOOK_NOT_FOUND'
      );
    }

    const after = { retryPolicy: updated.retryPolicy };
    const actor = getAuthenticatedActor(res) ?? developerId;

    logger.audit('WEBHOOK_RETRY_POLICY_UPDATED', actor, {
      developerId,
      actor,
      retryPolicy: updated.retryPolicy,
    });

    void auditStateChange(req, res, 'WEBHOOK_RETRY_POLICY_UPDATED', before, after);

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
  parseCapturedJson,
  (req: Request, res: Response) => {
    return res.status(200).json({ message: 'Webhook delivery accepted.', body: req.body });
  }
);

export function createWebhooksRouter(): Router {
  return router;
}

export default router;