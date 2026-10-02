import crypto from 'crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { WebhookConfig, WebhookPayload } from './webhook.types.js';
import { WebhookStore } from './webhook.store.js';
import { logger } from '../logger.js';
import { getCorrelationId, getRequestId } from '../utils/asyncContext.js';
import { getEffectiveRetryPolicy, calculateBackoff } from '../services/webhookRetry.js';
import { resolveUpstreamTarget, isBlockedAddress } from '../lib/upstreamTarget.js';
import { computeJitteredDelay, type RandomSource } from '../lib/retry.js';
import { validateWebhookUrl, WebhookValidationError } from './webhook.validator.js';

export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

export async function consumeCappedResponseBody(
    response: Response,
    maxBytes: number = MAX_WEBHOOK_RESPONSE_BYTES
): Promise<string> {
    if (!response.body) {
        if (typeof (response as any).text === 'function') {
            try {
                const text = await (response as any).text();
                return typeof text === 'string' && text.length > maxBytes
                    ? text.slice(0, maxBytes)
                    : text || '';
            } catch {
                return '';
            }
        }
        return '';
    }

    try {
        const reader = response.body.getReader();
        let receivedBytes = 0;
        const chunks: Uint8Array[] = [];

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    if (receivedBytes + value.byteLength > maxBytes) {
                        const remaining = maxBytes - receivedBytes;
                        if (remaining > 0) {
                            chunks.push(value.subarray(0, remaining));
                        }
                        try {
                            await reader.cancel('Response body exceeded maximum allowed size');
                        } catch {
                            // ignore cancel error
                        }
                        break;
                    }
                    chunks.push(value);
                    receivedBytes += value.byteLength;
                }
            }
        } catch {
            // ignore stream read error
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // ignore release error
            }
        }

        return Buffer.concat(chunks).toString('utf8');
    } catch {
        return '';
    }
}
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

/**
 * Builds an undici Agent whose connect.lookup returns only the previously
 * validated address. This pins the TCP connection to the exact IP that passed
 * SSRF validation, defeating DNS rebinding between validation and connect.
 * TLS SNI/Host verification still uses the original hostname because the
 * request URL is unchanged.
 */
function createPinnedAgent(hostname: string, pinnedAddress: string, pinnedFamily: number): Agent {
    return new Agent({
        connect: {
            lookup: (_host, _options, callback) => {
                // Ignore the resolver entirely; always return the validated IP.
                callback(null, [{ address: pinnedAddress, family: pinnedFamily }]);
            },
        },
    });
}

async function resolvePinnedTarget(url: string): Promise<{ address: string; family: number }> {
    const parsed = new URL(url);
    const resolved = await resolveUpstreamTarget(parsed.hostname);
    if (!resolved || resolved.addresses.length === 0) {
        throw new Error(`Unable to resolve upstream target for ${parsed.hostname}`);
    }
    const chosen = resolved.addresses[0];
    if (isBlockedAddress(chosen.address)) {
        throw new Error(`Blocked upstream address for ${parsed.hostname}: ${chosen.address}`);
    }
    return { address: chosen.address, family: chosen.family };
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
        let attemptsMade = 0;

        try {
            await validateWebhookUrl(config.url);
        } catch (err) {
            const failedAt = new Date().toISOString();
            const lastErrorMessage =
                err instanceof Error ? err.message : String(err);

            logger.warn(
                `[webhook] Pre-dispatch validation failed for ${config.url}:`,
                lastErrorMessage
            );
            logger.error(
                `[webhook] ✗ Failed to deliver ${payload.event} to ${config.url} after 0 attempts.`,
                err
            );

            WebhookStore.recordFailedDelivery({
                deliveryId,
                developerId: config.developerId,
                event: payload.event,
                url: config.url,
                failedAt,
                lastError: lastErrorMessage,
                attempts: 0,
            });
            return;
        }

        for (let attempt = 0; attempt < maxRetries; attempt++) {
let agent: Agent | undefined;
            attemptsMade = attempt + 1;
            try {
                const pinned = await resolvePinnedTarget(config.url);
                const parsed = new URL(config.url);
                agent = createPinnedAgent(parsed.hostname, pinned.address, pinned.family);

                const response = await undiciFetch(config.url, {
                    method: 'POST',
                    body,
                    headers,
                    redirect: 'manual',
                    signal: AbortSignal.timeout(10_000), // 10s timeout per attempt
                    dispatcher: agent,
                });

                const isRedirect =
                    (response.status >= 300 && response.status < 400) ||
                    response.type === 'opaqueredirect';

                if (isRedirect) {
                    if (response.body) {
                        await consumeCappedResponseBody(response);
                    }
                    const location = response.headers.get('location') || '';
                    const redirectMsg = location
                        ? `Webhook redirect to "${location}" refused (HTTP ${response.status}): redirects are not followed`
                        : `Webhook HTTP ${response.status} redirect refused: redirects are not followed`;
                    lastError = new Error(redirectMsg);
                    logger.warn(
                        `[webhook] ${redirectMsg} for ${config.url}, attempt ${attempt + 1}`
                    );
                    break;
                }

                if (response.ok) {
                    if (response.body) {
                        await consumeCappedResponseBody(response);
                    }
                    logger.info(
                        `[webhook] ✓ Delivered ${payload.event} to ${config.url}`,
                        `attempt ${attempt + 1}`
                    );
                    return;
                }

                if (response.body) {
                    await consumeCappedResponseBody(response);
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
            } finally {
                if (agent) {
                    await agent.close().catch(() => {});
                }
            }

            if (attempt < maxRetries - 1) {
                // Jitter keeps concurrent deliveries from retrying in lockstep.
                // The exponential value is also the ceiling, so a delivery never
                // waits longer than its configured backoff.
                const scheduledDelay = calculateBackoff(attempt, baseDelayMs);
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
            attempts: attemptsMade || maxRetries,
        });
    })());
}

export async function dispatchToAll(
    configs: WebhookConfig[],
    payload: WebhookPayload
): Promise<void> {
    await Promise.allSettled(configs.map((cfg) => dispatchWebhook(cfg, payload)));
}
