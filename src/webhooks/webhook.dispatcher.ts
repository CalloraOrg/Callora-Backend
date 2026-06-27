import crypto from 'crypto';
import { WebhookConfig, WebhookPayload, DeadLetterEntry, WebhookDeliveryStatus, WebhookRetryPolicy } from './webhook.types.js';
import { WebhookStore } from './webhook.store.js';
import { logger } from '../logger.js';

export const DEFAULT_RETRY_POLICY: Required<WebhookRetryPolicy> = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
};

let acceptingDispatches = true;
const inFlightDispatches = new Set<Promise<void>>();

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveRetryPolicy(config: WebhookConfig): Required<WebhookRetryPolicy> {
    return {
        maxAttempts: config.retryPolicy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        baseDelayMs: config.retryPolicy?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
        maxDelayMs: config.retryPolicy?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
        backoffMultiplier: config.retryPolicy?.backoffMultiplier ?? DEFAULT_RETRY_POLICY.backoffMultiplier,
    };
}

// Calculate exponential backoff with jitter to avoid thundering herd
function calculateBackoff(attempt: number, policy: Required<WebhookRetryPolicy>): number {
    const exponentialDelay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
    // Add jitter: random value between 0-25% of the exponential delay
    const jitter = Math.random() * 0.25 * exponentialDelay;
    const delayWithJitter = exponentialDelay + jitter;
    // Cap at maximum delay
    return Math.min(delayWithJitter, policy.maxDelayMs);
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
 * Operational Limits (defaults; each subscription may override via retryPolicy):
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
        const policy = resolveRetryPolicy(config);
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

        for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
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

            if (attempt < policy.maxAttempts - 1) {
                const delay = calculateBackoff(attempt, policy);
                console.log(`[webhook] Retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }

        logger.error(
            `[webhook] ✗ Failed to deliver ${payload.event} to ${config.url} after ${policy.maxAttempts} attempts.`,
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
