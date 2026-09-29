import crypto from 'crypto';
import { WebhookConfig, WebhookPayload } from './webhook.types.js';
import { WebhookStore } from './webhook.store.js';
import { logger } from '../logger.js';
import { getCorrelationId, getRequestId } from '../utils/asyncContext.js';
import { getEffectiveRetryPolicy } from '../services/webhookRetry.js';
import { computeJitteredDelay, type RandomSource } from '../lib/retry.js';

let acceptingDispatches = true;
const inFlightDispatches = new Set<Promise<void>>();

/**
 * Random source used for retry backoff jitter. Injectable so tests can supply
 * a seeded, deterministic sequence; production uses `Math.random`.
 */
let jitterRandom: RandomSource = Math.random;

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
    jitterRandom = Math.random;
}

/**
 * Overrides the random source used to jitter webhook retry delays.
 * Tests pass a seeded generator to make backoff deterministic.
 */
export function setWebhookJitterRandom(random: RandomSource): void {
    jitterRandom = random;
}

/**
 * Dispatches a webhook payload to the registered URL.
 * 
 * Operational Limits:
 * - Max retries: Uses subscription's retryPolicy.maxRetries (defaults to 5)
 * - Timeout: 10 seconds per attempt
 * - Backoff: Exponential with full jitter, using subscription's retryPolicy.baseDelayMs
 *   (defaults to 1s). The exponential value is an upper bound; actual delays are randomised
 *   below it so recovering receivers are not hit by a synchronised retry storm.
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

    const { maxRetries, baseDelayMs } = getEffectiveRetryPolicy(config.retryPolicy);

    return trackDispatch((async () => {
        const body = JSON.stringify(payload);
        const deliveryId = crypto.randomUUID();
        const requestId = getRequestId();
        const correlationId = getCorrelationId();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'Callora-Webhook/1.0',
            'X-Callora-Event': payload.event,
            'X-Callora-Timestamp': payload.timestamp,
            'X-Callora-Delivery': deliveryId,
        };
        if (requestId) {
            headers['X-Request-Id'] = requestId;
        }
        if (correlationId) {
            headers['X-Correlation-Id'] = correlationId;
        }

        if (config.secret) {
            headers['X-Callora-Signature'] = `sha256=${signPayload(config.secret, body)}`;
        }

        let lastError: unknown;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(config.url, {
                    method: 'POST',
                    body,
                    headers,
                    signal: AbortSignal.timeout(10_000), // 10s timeout per attempt
                });

                if (response.ok) {
                    logger.info(
                        `[webhook] ✓ Delivered ${payload.event} to ${config.url}`,
                        `attempt ${attempt + 1}`
                    );
                    return;
                }

                lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
                logger.warn(
                    `[webhook] Non-2xx response (${response.status}) for ${config.url}`,
                    `attempt ${attempt + 1}`
                );
            } catch (err) {
                lastError = err;
                logger.warn(
                    `[webhook] Error delivering to ${config.url}, attempt ${attempt + 1}:`,
                    (err as Error).message
                );
            }

            if (attempt < maxRetries - 1) {
                // Jitter keeps concurrent deliveries from retrying in lockstep.
                // The exponential value is also the ceiling, so a delivery never
                // waits longer than its configured backoff.
                const scheduledDelay = baseDelayMs * Math.pow(2, attempt);
                const delay = computeJitteredDelay(scheduledDelay, {
                    strategy: 'full',
                    random: jitterRandom,
                    maxDelayMs: scheduledDelay,
                });
                logger.info(
                    `[webhook] Retrying in ${delay}ms (scheduled ${scheduledDelay}ms)...`
                );
                await sleep(delay);
            }
        }

        const failedAt = new Date().toISOString();
        const lastErrorMessage =
            lastError instanceof Error ? lastError.message : String(lastError);

        logger.error(
            `[webhook] ✗ Failed to deliver ${payload.event} to ${config.url} after ${maxRetries} attempts.`,
            lastError
        );

        // Persist operational failure metadata (no payload or secrets).
        WebhookStore.recordFailedDelivery({
            deliveryId,
            developerId: config.developerId,
            event: payload.event,
            url: config.url,
            failedAt,
            lastError: lastErrorMessage,
            attempts: maxRetries,
        });
    })());
}

export async function dispatchToAll(
    configs: WebhookConfig[],
    payload: WebhookPayload
): Promise<void> {
    await Promise.allSettled(configs.map((cfg) => dispatchWebhook(cfg, payload)));
}
