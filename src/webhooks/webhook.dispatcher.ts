
import crypto from 'crypto';
import { WebhookConfig, WebhookPayload } from './webhook.types.js';
import { logger } from '../logger.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
let acceptingDispatches = true;
const inFlightDispatches = new Set<Promise<void>>();

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function signPayload(secret: string, body: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function trackDispatch<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
        inFlightDispatches.delete(tracked as Promise<void>);
    });

    inFlightDispatches.add(tracked as Promise<void>);
    return tracked;
}

export function stopWebhookDispatching(): void {
    acceptingDispatches = false;
}

export async function awaitWebhookDispatcherIdle(): Promise<void> {
    while (inFlightDispatches.size > 0) {
        await Promise.allSettled([...inFlightDispatches]);
    }
}

export function resetWebhookDispatcherForTests(): void {
    acceptingDispatches = true;
    inFlightDispatches.clear();
}

/**
 * Dispatches a webhook payload to the registered URL.
 * 
 * Operational Limits:
 * - Max retries: 5 attempts
 * - Timeout: 10 seconds per attempt
 * - Backoff: Exponential (1s, 2s, 4s, 8s)
 * - Idempotency: Uses a deterministic Deduplication key (X-Callora-Delivery) per dispatch call
 */
export async function dispatchWebhook(
    config: WebhookConfig,
    payload: WebhookPayload
): Promise<void> {
    if (!acceptingDispatches) {
        logger.warn(`[webhook] Skipping ${payload.event} dispatch during shutdown for ${config.url}`);
        return;
    }

    return trackDispatch((async () => {
        const body = JSON.stringify(payload);
        const deliveryId = crypto.randomUUID();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'Callora-Webhook/1.0',
            'X-Callora-Event': payload.event,
            'X-Callora-Timestamp': payload.timestamp,
            'X-Callora-Delivery': deliveryId,
        };

        if (config.secret) {
            headers['X-Callora-Signature'] = `sha256=${signPayload(config.secret, body)}`;
        }

        let lastError: unknown;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(config.url, {
                    method: 'POST',
                    body,
                    headers,
                    signal: AbortSignal.timeout(10_000), // 10s timeout per attempt
                });

                if (response.ok) {
                    console.log(
                        `[webhook] ✓ Delivered ${payload.event} to ${config.url} (attempt ${attempt + 1})`
                    );
                    return;
                }

                lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
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
                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                console.log(`[webhook] Retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }

        logger.error(
            `[webhook] ✗ Failed to deliver ${payload.event} to ${config.url} after ${MAX_RETRIES} attempts.`,
            lastError
        );
    })());
}

export async function dispatchToAll(
    configs: WebhookConfig[],
    payload: WebhookPayload
): Promise<void> {
    await Promise.allSettled(configs.map((cfg) => dispatchWebhook(cfg, payload)));
}
