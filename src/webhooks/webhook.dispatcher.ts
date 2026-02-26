import axios from 'axios';
import crypto from 'crypto';
import { WebhookConfig, WebhookPayload } from './webhook.types.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function signPayload(secret: string, body: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export async function dispatchWebhook(
    config: WebhookConfig,
    payload: WebhookPayload
): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Callora-Webhook/1.0',
        'X-Callora-Event': payload.event,
        'X-Callora-Timestamp': payload.timestamp,
    };

    if (config.secret) {
        headers['X-Callora-Signature'] = `sha256=${signPayload(config.secret, body)}`;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
        const response = await axios.post(config.url, body, {
            headers,
            timeout: 10_000, // 10s timeout per attempt
            maxRedirects: 3,
        });

        if (response.status >= 200 && response.status < 300) {
            console.log(
            `[webhook] ✓ Delivered ${payload.event} to ${config.url} (attempt ${attempt + 1})`
            );
            return; // success — stop retrying
        }

        console.warn(
            `[webhook] Non-2xx response (${response.status}) for ${config.url}, attempt ${attempt + 1}`
        );
        } catch (err) {
        lastError = err;
        console.warn(
            `[webhook] Error delivering to ${config.url}, attempt ${attempt + 1}:`,
            (err as Error).message
        );
        }

        if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt); // exponential backoff
        console.log(`[webhook] Retrying in ${delay}ms...`);
        await sleep(delay);
        }
    }

    console.error(
        `[webhook] ✗ Failed to deliver ${payload.event} to ${config.url} after ${MAX_RETRIES} attempts.`,
        lastError
    );
}

export async function dispatchToAll(
    configs: WebhookConfig[],
    payload: WebhookPayload
): Promise<void> {
    await Promise.allSettled(configs.map((cfg) => dispatchWebhook(cfg, payload)));
}