/**
 * src/routes/admin/webhooks.ts
 *
 * Composes all admin webhook routes under one router:
 *   POST /api/admin/webhooks/rotate-key     (from webhookKeys)
 *   GET  /api/admin/webhooks/grace-window   (from webhookKeys)
 *   GET  /api/admin/webhooks/monitor        ← new
 *
 * Authentication: adminAuth middleware applied at the parent admin router.
 * IP allowlist:   createAdminIpAllowlist() applied at the parent admin router.
 *
 * Mount in admin.ts:
 *   adminRouter.use('/webhooks', createAdminWebhooksRouter());
 */

import { Router, type Response } from 'express';
import { getClientIp } from '../../lib/clientIp.js';
import { AppError, InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getWebhookMonitorSnapshot } from '../../services/webhookMonitor.js';
import { createWebhookKeysRouter } from './webhookKeys.js';

export { createWebhookKeysRouter } from './webhookKeys.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

/**
 * Factory that returns the composite admin webhook router.
 *
 * Accepts optional deps forwarded to the key-rotation sub-router so tests can
 * inject stubs without touching the module-level singleton.
 */
export function createAdminWebhooksRouter(
    keysRouterDeps?: Parameters<typeof createWebhookKeysRouter>[0],
): Router {
    const router = Router();

    // Mount the existing key-rotation routes unchanged (rotate-key, grace-window).
    router.use('/', createWebhookKeysRouter(keysRouterDeps));

    // ── GET /monitor ──────────────────────────────────────────────────────────
    /**
     * @openapi
     * /api/admin/webhooks/monitor:
     *   get:
     *     summary: Webhook delivery monitoring snapshot
     *     description: |
     *       Returns the last 100 failed webhook deliveries (most-recent first),
     *       the current Dead-Letter Queue depth, and per-subscription statistics.
     *
     *       Only operational metadata is returned; raw payloads and signing
     *       secrets are never exposed.
     *     security:
     *       - AdminApiKey: []
     *       - AdminJWT: []
     *     responses:
     *       '200':
     *         description: Monitoring snapshot.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 data:
     *                   type: object
     *                   properties:
     *                     failedDeliveries:
     *                       type: array
     *                       maxItems: 100
     *                       items:
     *                         type: object
     *                         properties:
     *                           deliveryId:  { type: string, format: uuid }
     *                           developerId: { type: string }
     *                           event:       { type: string }
     *                           url:         { type: string, format: uri }
     *                           failedAt:    { type: string, format: date-time }
     *                           lastError:   { type: string }
     *                           attempts:    { type: integer }
     *                     dlqDepth:
     *                       type: integer
     *                       description: Current number of entries in the Dead-Letter Queue.
     *                     subscriptions:
     *                       type: array
     *                       items:
     *                         type: object
     *                         properties:
     *                           developerId:  { type: string }
     *                           url:          { type: string, format: uri }
     *                           events:       { type: array, items: { type: string } }
     *                           registeredAt: { type: string, format: date-time }
     *       '401': { $ref: '#/components/responses/Unauthorized' }
     *       '500': { $ref: '#/components/responses/InternalServerError' }
     */
    router.get('/monitor', (req, res: Response, next) => {
        try {
            const snapshot = getWebhookMonitorSnapshot();

            logger.info('[admin] webhook monitor snapshot requested', {
                actor: res.locals.adminActor,
                clientIp: getClientIp(req, TRUST_PROXY),
                failedDeliveryCount: snapshot.failedDeliveries.length,
                dlqDepth: snapshot.dlqDepth,
                subscriptionCount: snapshot.subscriptions.length,
            });

            return res.status(200).json({ data: snapshot });
        } catch (error) {
            if (error instanceof AppError) {
                next(error);
                return;
            }
            logger.error('[admin] webhook monitor failed', error);
            next(new InternalServerError('Failed to retrieve webhook monitor data'));
        }
    });

    return router;
}

export default createAdminWebhooksRouter();
