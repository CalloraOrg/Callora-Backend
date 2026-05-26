import { EventEmitter } from 'events';
import {
    WebhookEventType,
    WebhookPayload,
    NewApiCallData,
    SettlementCompletedData,
    LowBalanceAlertData,
} from '../webhooks/webhook.types.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import { dispatchToAll } from '../webhooks/webhook.dispatcher.js';

export interface CalloraEventMap {
    new_api_call: [developerId: string, data: NewApiCallData];
    settlement_completed: [developerId: string, data: SettlementCompletedData];
    low_balance_alert: [developerId: string, data: LowBalanceAlertData];
}

export type CalloraEventName = keyof CalloraEventMap;
export type CalloraEventListener<TEvent extends CalloraEventName> = (
    ...args: CalloraEventMap[TEvent]
) => void;
export type CalloraEventUnsubscribe = () => void;

export class CalloraEventEmitter {
    private readonly emitter = new EventEmitter();

    on<TEvent extends CalloraEventName>(
        event: TEvent,
        listener: CalloraEventListener<TEvent>
    ): CalloraEventUnsubscribe {
        this.emitter.on(event, listener as (...args: unknown[]) => void);

        let active = true;
        return () => {
            if (!active) {
                return;
            }

            active = false;
            this.off(event, listener);
        };
    }

    off<TEvent extends CalloraEventName>(
        event: TEvent,
        listener: CalloraEventListener<TEvent>
    ): this {
        this.emitter.off(event, listener as (...args: unknown[]) => void);
        return this;
    }

    emit<TEvent extends CalloraEventName>(
        event: TEvent,
        ...args: CalloraEventMap[TEvent]
    ): boolean {
        return this.emitter.emit(event, ...args);
    }

    listenerCount<TEvent extends CalloraEventName>(event: TEvent): number {
        return this.emitter.listenerCount(event);
    }
}

export const calloraEvents = new CalloraEventEmitter();

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
        (cfg: { developerId: string }) => cfg.developerId === developerId
    );

    if (configs.length > 0) {
        await dispatchToAll(configs, payload);
    }
}

// Bind listeners
calloraEvents.on(
    'new_api_call',
    (developerId: string, data: NewApiCallData) => {
        handleEvent('new_api_call', developerId, data as unknown as Record<string, unknown>);
    }
);

calloraEvents.on(
    'settlement_completed',
    (developerId: string, data: SettlementCompletedData) => {
        handleEvent('settlement_completed', developerId, data as unknown as Record<string, unknown>);
    }
);

calloraEvents.on(
    'low_balance_alert',
    (developerId: string, data: LowBalanceAlertData) => {
        handleEvent('low_balance_alert', developerId, data as unknown as Record<string, unknown>);
    }
);
