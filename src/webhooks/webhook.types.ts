export type WebhookEventType =
    | 'new_api_call'
    | 'settlement_completed'
    | 'low_balance_alert'
    | 'quota.threshold.reached';

export interface WebhookRetryPolicy {
    /** Maximum number of delivery attempts (must be >= 1). */
    maxAttempts?: number;
    /** Initial delay before the first retry, in milliseconds (must be >= 0). */
    baseDelayMs?: number;
    /** Maximum delay between retries, in milliseconds (must be >= 0). */
    maxDelayMs?: number;
    /** Exponential backoff multiplier (must be >= 1). */
    backoffMultiplier?: number;
}

export interface WebhookConfig {
    developerId: string;
    url: string;
    events: string[];
    secret?: string; // legacy alias for secret_current
    secret_current?: string; // for HMAC signature (optional but recommended)
    secret_previous?: string;
    previous_expires_at?: Date;
    /** Optional per-subscription override of the default webhook retry policy. */
    retryPolicy?: WebhookRetryPolicy;
    createdAt: Date;
}

export interface WebhookPayload {
    event: WebhookEventType;
    timestamp: string;       // ISO 8601
    developerId: string;
    data: Record<string, unknown>;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeadLetterEntry {
    deliveryId: string;
    config: WebhookConfig;
    payload: WebhookPayload;
    failedAt: string;        // ISO 8601
    lastError: string;
    attempts: number;
}

// ---------------------------------------------------------------------------
// Per-event payload shapes (for documentation and type-safe construction)
// ---------------------------------------------------------------------------

export interface NewApiCallData {
    apiId: string;
    endpoint: string;
    method: string;
    statusCode: number;
    latencyMs: number;
    creditsUsed: number;
}

export interface SettlementCompletedData {
    settlementId: string;
    amount: string;          // in XLM or token units
    asset: string;
    txHash: string;
    settledAt: string;
}

export interface LowBalanceAlertData {
    currentBalance: string;
    thresholdBalance: string;
    asset: string;
}

/** Fired when a developer crosses 80%, 95%, or 100% of their monthly call quota. */
export interface QuotaThresholdReachedData {
    /** Billing period in YYYY-MM format, e.g. "2026-06". */
    period: string;
    /** Threshold percentage that was crossed: 80 | 95 | 100. */
    threshold: 80 | 95 | 100;
    /** Total API calls made by the developer this period. */
    currentUsage: number;
    /** Configured monthly call quota for this developer. */
    quotaLimit: number;
    /** Actual usage as a percentage of quota, rounded to two decimal places. */
    usagePercent: number;
}
