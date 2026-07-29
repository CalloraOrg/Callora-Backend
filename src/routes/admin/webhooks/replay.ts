/**
 * src/routes/admin/webhooks/replay.ts
 *
 * Admin webhook replay endpoint.
 *
 * Route:
 *   POST /api/admin/webhooks/replay
 *
 * Re-dispatches a webhook from the Dead-Letter Queue by deliveryId.
 * The admin provides the deliveryId of the failed delivery to replay.
 *
 * Authentication: adminAuth middleware applied at the parent admin router.
 * Audit: Every replay is logged via logger.audit() with correlation context.
 *
 * Security:
 *   - Input validation at the boundary (deliveryId must be a non-empty string)
 *   - No payload/secrets leaked in responses or logs
 *   - Dispatch runs asynchronously after the response is sent
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getClientIp } from '../../../lib/clientIp.js';
import { AppError, BadRequestError, NotFoundError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { WebhookStore } from '../../../webhooks/webhook.store.js';
import { dispatchWebhook } from '../../../webhooks/webhook.dispatcher.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

/**
 * Factory that returns the admin webhook replay router.
 */
export function createAdminWebhookReplayRouter(): Router {
    const router = Router();

    /**
     * @openapi
     * /api/admin/webhooks/replay:
     *   post:
     *     summary: Replay a failed webhook delivery from the Dead-Letter Queue
     *     description: |
     *       Re-dispatches a webhook that previously failed, using the original
     *       payload and configuration stored in the Dead-Letter Queue.
     *
     *       The dispatch runs asynchronously — the endpoint returns immediately
     *       once the replay has been queued. Monitor the delivery via the
     *       GET /api/admin/webhooks/monitor endpoint.
     *     security:
     *       - AdminApiKey: []
     *       - AdminJWT: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [ deliveryId ]
     *             properties:
     *               deliveryId:
     *                 type: string
     *                 format: uuid
     *                 description: The delivery ID from a failed webhook (found in the monitor snapshot).
     *     responses:
     *       '200':
     *         description: Webhook replay queued.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 data:
     *                   type: object
     *                   properties:
     *                     deliveryId: { type: string, format: uuid }
     *                     status:    { type: string, enum: [replayed] }
     *                     targetUrl: { type: string, format: uri }
     *                     event:     { type: string }
     *                     developerId: { type: string }
     *                     replayedAt: { type: string, format: date-time }
     *       '400': { $ref: '#/components/responses/BadRequest' }
     *       '401': { $ref: '#/components/responses/Unauthorized' }
     *       '404': { $ref: '#/components/responses/NotFound' }
     *       '500': { $ref: '#/components/responses/InternalServerError' }
     */
    router.post('/', (req: Request, res: Response, next: NextFunction) => {
        try {
            // ── Input validation ────────────────────────────────────────────
            if (!req.body || typeof req.body !== 'object') {
                throw new BadRequestError(
                    'Request body is required',
                    'INVALID_BODY',
                );
            }

            const { deliveryId } = req.body;

            if (!deliveryId || typeof deliveryId !== 'string' || deliveryId.trim() === '') {
                throw new BadRequestError(
                    'deliveryId is required and must be a non-empty string',
                    'INVALID_DELIVERY_ID',
                );
            }

            const trimmedDeliveryId = deliveryId.trim();

            // ── Look up DLQ entry ───────────────────────────────────────────
            const entry = WebhookStore.getFromDlq(trimmedDeliveryId);
            if (!entry) {
                throw new NotFoundError(
                    `No Dead-Letter Queue entry found for deliveryId: ${trimmedDeliveryId}`,
                    'DLQ_ENTRY_NOT_FOUND',
                );
            }

            // ── Fire replay (async, not awaited) ───────────────────────────
            // The dispatch runs its own retry loop and failure recording.
            // We do NOT await it so the admin gets an immediate confirmation.
            dispatchWebhook(entry.config, entry.payload).catch((error) => {
                logger.error('[admin] Replayed webhook delivery failed', {
                    deliveryId: trimmedDeliveryId,
                    developerId: entry.config.developerId,
                    targetUrl: entry.config.url,
                    event: entry.payload.event,
                    error: error instanceof Error ? error.message : String(error),
                });
            });

            // ── Audit log ───────────────────────────────────────────────────
            const correlationId =
                (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined) ??
                (typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : undefined);

            logger.audit('WEBHOOK_REPLAYED', res.locals.adminActor, {
                deliveryId: trimmedDeliveryId,
                developerId: entry.config.developerId,
                targetUrl: entry.config.url,
                event: entry.payload.event,
                clientIp: getClientIp(req, TRUST_PROXY),
                userAgent: req.get('User-Agent'),
                correlationId,
            });

            return res.status(200).json({
                data: {
                    deliveryId: entry.deliveryId,
                    status: 'replayed',
                    targetUrl: entry.config.url,
                    event: entry.payload.event,
                    developerId: entry.config.developerId,
                    replayedAt: new Date().toISOString(),
                },
            });
        } catch (error) {
            if (error instanceof AppError) {
                next(error);
                return;
            }
            logger.error('[admin] Webhook replay failed unexpectedly', error);
            next(new InternalServerError('Failed to replay webhook'));
        }
    });

    return router;
}

export default createAdminWebhookReplayRouter();
