export type WebhookEventType =
    | 'new_api_call'
    | 'settlement_completed'
    | 'low_balance_alert'
    | 'quota.threshold.reached'
    | 'invoice_created'
    | 'usage.anomaly.detected'
    | 'fee_abstraction.executed'
    | 'usage_event.created';

export interface RetryPolicy {
  maxRetries?: number;
  baseDelayMs?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
};

export interface WebhookConfig {
    developerId: string;
    url: string;
    events: string[];
    secret?: string; // legacy alias for secret_current
    secret_current?: string; // for HMAC signature (optional but recommended)
    secret_previous?: string;
    previous_expires_at?: Date;
    createdAt: Date;
    retryPolicy?: RetryPolicy; // Per-subscription override for retry behavior
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
export interface InvoiceCreatedData {
    invoiceId: string;
    developerId: string;
    periodId: string;
    totalAmount: string;
    currency: string;
    createdAt: string;
}
export interface LowBalanceAlertData {
    currentBalance: string;
    thresholdBalance: string;
    asset: string;
}

/** Fired when a developer's 5-minute traffic exceeds baseline * multiplier. */
export interface UsageAnomalyDetectedData {
    /** ISO 8601 start of the anomalous window (UTC). */
    windowStart: string;
    /** ISO 8601 end of the anomalous window (UTC). */
    windowEnd: string;
    /** Call count in the anomalous window. */
    currentCalls: number;
    /** Mean call count across the trailing baseline windows. */
    baselineMean: number;
    /** Configured multiplier threshold that was exceeded. */
    multiplier: number;
    /** currentCalls / baselineMean (Infinity when baselineMean is 0). */
    ratio: number;
    /** Window size in milliseconds. */
    windowMs: number;
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

/**
 * Fired when a new usage event is recorded for a developer's API call.
 * Contains the metered usage details for the request that was just processed.
 */
export interface UsageEventCreatedData {
    /** Unique identifier for this usage event. */
    id: string;
    /** Unique request identifier for idempotency. */
    requestId: string;
    /** The API that was called. */
    apiId: string;
    /** The specific endpoint that was hit. */
    endpointId: string;
    /** Developer who owns the API key used for this request. */
    developerId: string;
    /** Amount in USDC charged for this request. */
    amountUsdc: number;
    /** HTTP status code returned by the upstream API. */
    statusCode: number;
    /** ISO 8601 timestamp of when the usage event was recorded. */
    timestamp: string;
}


