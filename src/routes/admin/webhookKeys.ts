/**
 * src/routes/admin/webhookKeys.ts
 *
 * Admin route: POST /api/admin/webhooks/rotate-key
 *
 * Generates a new platform webhook signing secret, demotes the previous one
 * into a configurable grace window, writes an audit log, and notifies the
 * admin email address (fire-and-forget).
 *
 * Authentication:  adminAuth middleware (applied on the parent admin router).
 * IP allowlist:    createAdminIpAllowlist() (also applied by parent router).
 *
 * Mounts as:
 *   import webhookKeysRouter from './routes/admin/webhookKeys.js';
 *   adminRouter.use('/webhooks', webhookKeysRouter);
 *
 * Which exposes:  POST /api/admin/webhooks/rotate-key
 */

import { Router } from 'express';
import { getClientIp } from '../../lib/clientIp.js';
import {
  AppError,
  InternalServerError,
  BadRequestError,
} from '../../errors/index.js';
import { logger } from '../../logger.js';
import {
  WebhookSignerService,
  InMemoryWebhookKeyStore,
  resolveGraceWindowMs,
  type WebhookSignerDeps,
  type RotationResult,
} from '../../services/webhookSigner.js';

// ---------------------------------------------------------------------------
// Shared service instance
// ---------------------------------------------------------------------------
//
// In a single-process deploy the in-memory store is sufficient.
// For multi-replica deployments, replace `InMemoryWebhookKeyStore` with a
// Postgres/SQLite-backed implementation that satisfies `WebhookKeyStore`.
//
// The instance is module-level so it is created once per process and shared
// across requests, preserving key state between rotations.

const defaultStore = new InMemoryWebhookKeyStore();

/**
 * Build the admin notification callback.
 * Logs the notification; swap for nodemailer/SES/etc. as needed.
 */
function buildAdminNotifier(): (result: RotationResult) => Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL ?? '';

  return async (result: RotationResult) => {
    const target = adminEmail || '(no ADMIN_EMAIL configured)';
    logger.info(
      `[webhook-key-rotation] Admin notification → ${target}`,
      {
        event: 'WEBHOOK_KEY_ROTATION_NOTIFICATION',
        recipient: target,
        newKeyId: result.newKey.id,
        previousKeyId: result.previousKey?.id ?? null,
        graceWindowMs: result.graceWindowMs,
        previousKeyExpiresAt: result.previousKeyExpiresAt,
        // rawSecret intentionally NOT logged
      },
    );

    // TODO: integrate real email transport here, e.g.:
    //
    //   await mailer.send({
    //     to: adminEmail,
    //     subject: 'Webhook signing key rotated',
    //     text: [
    //       `A new webhook signing key was generated (id: ${result.newKey.id}).`,
    //       `The previous key expires at: ${result.previousKeyExpiresAt ?? 'N/A'}.`,
    //       `Grace window: ${result.graceWindowMs / 1000}s.`,
    //       `Distribute the new key to subscribers before the grace window closes.`,
    //     ].join('\n'),
    //   });
  };
}

/**
 * Factory — lets callers inject a custom WebhookSignerService in tests.
 */
export function createWebhookKeysRouter(
  deps?: Partial<WebhookSignerDeps>,
): Router {
  const service = new WebhookSignerService({
    store: deps?.store ?? defaultStore,
    notifyAdmin: deps?.notifyAdmin ?? buildAdminNotifier(),
    now: deps?.now,
    graceWindowMs: deps?.graceWindowMs,
  });

  const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /rotate-key
  // -------------------------------------------------------------------------
  /**
   * @openapi
   * /api/admin/webhooks/rotate-key:
   *   post:
   *     summary: Rotate the platform webhook signing key
   *     description: |
   *       Generates a new HMAC-SHA256 signing key and immediately activates it.
   *       The previous key remains valid for a configurable grace window
   *       (WEBHOOK_SECRET_ROTATION_GRACE_MS, default 24 h) so subscribers can
   *       roll over their verification logic without downtime.
   *
   *       **Security notes**
   *       - The raw secret is returned ONCE in this response and never stored.
   *         Distribute it to webhook subscribers immediately.
   *       - Only the SHA-256 hash of each key is persisted in the database.
   *       - Every call is recorded in the audit log.
   *     security:
   *       - AdminApiKey: []
   *       - AdminJWT: []
   *     responses:
   *       '200':
   *         description: Key rotated successfully.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: object
   *                   properties:
   *                     newKeyId:             { type: string, format: uuid }
   *                     rawSecret:            { type: string, description: "One-time exposure — store securely immediately." }
   *                     graceWindowMs:        { type: integer }
   *                     previousKeyId:        { type: string, nullable: true }
   *                     previousKeyExpiresAt: { type: string, format: date-time, nullable: true }
   *                     rotatedAt:            { type: string, format: date-time }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '500': { $ref: '#/components/responses/InternalServerError' }
   */
  router.post('/rotate-key', async (req, res, next) => {
    // Validate Content-Type when a body is present (guard against stray data)
    const contentType = req.get('Content-Type') ?? '';
    if (req.body && Object.keys(req.body).length > 0 && !contentType.includes('application/json')) {
      next(new BadRequestError('Content-Type must be application/json when a body is supplied'));
      return;
    }

    try {
      const actor: string = res.locals.adminActor as string;
      const result = await service.rotateKey(actor);

      // Structured audit entry (also written inside the service, this provides
      // HTTP-layer context that the service layer cannot see)
      logger.audit('ADMIN_WEBHOOK_ROTATE_KEY', actor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        newKeyId: result.newKey.id,
        previousKeyId: result.previousKey?.id ?? null,
        graceWindowMs: result.graceWindowMs,
        previousKeyExpiresAt: result.previousKeyExpiresAt,
      });

      return res.status(200).json({
        data: {
          newKeyId: result.newKey.id,
          /**
           * rawSecret is returned ONCE and never stored in plaintext.
           * Subscribers must update their verification logic before
           * previousKeyExpiresAt to avoid signature failures.
           */
          rawSecret: result.rawSecret,
          graceWindowMs: result.graceWindowMs,
          previousKeyId: result.previousKey?.id ?? null,
          previousKeyExpiresAt: result.previousKeyExpiresAt,
          rotatedAt: result.newKey.created_at,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Webhook key rotation failed', error);
      next(new InternalServerError('Webhook key rotation failed'));
    }
  });

  /**
   * GET /grace-window
   *
   * Convenience endpoint — returns the currently-configured grace window so
   * operators can inspect it without reading server environment variables.
   */
  router.get('/grace-window', (_req, res) => {
    res.json({
      data: {
        graceWindowMs: resolveGraceWindowMs(deps?.graceWindowMs),
        graceWindowHours: resolveGraceWindowMs(deps?.graceWindowMs) / 3_600_000,
      },
    });
  });

  return router;
}

/** Default export: router using the shared in-memory store. */
export default createWebhookKeysRouter();