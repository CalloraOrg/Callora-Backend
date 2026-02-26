import { EventEmitter } from 'events';
import {
    WebhookEventType,
    WebhookPayload,
    NewApiCallData,
    SettlementCompletedData,
    LowBalanceAlertData,
} from '../webhooks/webhook.types';
import { WebhookStore } from '../webhooks/webhook.store';
import { dispatchToAll } from '../webhooks/webhook.dispatcher';

export const calloraEvents = new EventEmitter();

async function handleEvent(
    event: WebhookEventType,
    developerId: string,
    data: Record<string, unknown>
): Promise<void> {
    const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        developerId,
        data,
    };

    const configs = WebhookStore.getByEvent(event).filter(
        (cfg) => cfg.developerId === developerId
    );

    if (configs.length > 0) {
        await dispatchToAll(configs, payload);
    }
}

// Bind listeners
calloraEvents.on(
    'new_api_call',
    (developerId: string, data: NewApiCallData) => {
        handleEvent('new_api_call', developerId, data as Record<string, unknown>);
    }
);

calloraEvents.on(
    'settlement_completed',
    (developerId: string, data: SettlementCompletedData) => {
        handleEvent('settlement_completed', developerId, data as Record<string, unknown>);
    }
);

calloraEvents.on(
    'low_balance_alert',
    (developerId: string, data: LowBalanceAlertData) => {
        handleEvent('low_balance_alert', developerId, data as Record<string, unknown>);
    }
);