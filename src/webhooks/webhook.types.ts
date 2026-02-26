export type WebhookEventType =
    | 'new_api_call'
    | 'settlement_completed'
    | 'low_balance_alert';

export interface WebhookConfig {
    developerId: string;
    url: string;
    events: WebhookEventType[];
    secret?: string; // for HMAC signature (optional but recommended)
    createdAt: Date;
}

export interface WebhookPayload {
    event: WebhookEventType;
    timestamp: string;       // ISO 8601
    developerId: string;
    data: Record<string, unknown>;
}

// Payload shapes per event type (for documentation purposes)
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