import { Router, Request, Response } from 'express';
import { validateWebhookUrl, WebhookValidationError } from './webhook.validator';
import { WebhookStore } from './webhook.store';
import { WebhookEventType } from './webhook.types';

const router = Router();

const VALID_EVENTS: WebhookEventType[] = [
    'new_api_call',
    'settlement_completed',
    'low_balance_alert',
];

// POST /api/webhooks — Register a webhook
router.post('/', async (req: Request, res: Response) => {
    const { developerId, url, events, secret } = req.body;

    if (!developerId || !url || !Array.isArray(events) || events.length === 0) {
        return res.status(400).json({
        error: 'developerId, url, and a non-empty events array are required.',
        });
    }

    const invalidEvents = events.filter((e: string) => !VALID_EVENTS.includes(e as WebhookEventType));
    if (invalidEvents.length > 0) {
        return res.status(400).json({
        error: `Invalid event types: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`,
        });
    }

    try {
        await validateWebhookUrl(url);
    } catch (err) {
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
    const { secret: _s, ...safeConfig } = config;
    return res.json(safeConfig);
});

// DELETE /api/webhooks/:developerId — Remove webhook
router.delete('/:developerId', (req: Request, res: Response) => {
    WebhookStore.delete(req.params.developerId);
    return res.json({ message: 'Webhook removed.' });
});

export default router;