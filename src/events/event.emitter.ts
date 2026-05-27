import { logger } from '../logger.js';
import { dispatchToAll } from '../webhooks/webhook.dispatcher.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import type {
  LowBalanceAlertData,
  NewApiCallData,
  SettlementCompletedData,
  WebhookPayload,
} from '../webhooks/webhook.types.js';

export interface CalloraEventPayloadMap {
  new_api_call: NewApiCallData;
  settlement_completed: SettlementCompletedData;
  low_balance_alert: LowBalanceAlertData;
}

export type CalloraEventName = keyof CalloraEventPayloadMap;

export type CalloraEventListener<K extends CalloraEventName> = (
  developerId: string,
  data: CalloraEventPayloadMap[K],
) => void | Promise<void>;

export type CalloraEventUnsubscribe = () => void;

type ListenerSetMap = {
  [K in CalloraEventName]: Set<CalloraEventListener<K>>;
};

const createListenerSetMap = (): ListenerSetMap => ({
  new_api_call: new Set<CalloraEventListener<'new_api_call'>>(),
  settlement_completed: new Set<CalloraEventListener<'settlement_completed'>>(),
  low_balance_alert: new Set<CalloraEventListener<'low_balance_alert'>>(),
});

async function handleEvent<K extends CalloraEventName>(
  event: K,
  developerId: string,
  data: CalloraEventPayloadMap[K],
): Promise<void> {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    developerId,
    data: data as unknown as Record<string, unknown>,
  };

  const configs = WebhookStore.getByEvent(event).filter(
    (cfg: { developerId: string }) => cfg.developerId === developerId,
  );

  if (configs.length > 0) {
    await dispatchToAll(configs, payload);
  }
}

class TypedCalloraEventEmitter {
  private readonly listeners: ListenerSetMap = createListenerSetMap();

  on<K extends CalloraEventName>(
    event: K,
    listener: CalloraEventListener<K>,
  ): CalloraEventUnsubscribe {
    this.listeners[event].add(listener);
    return () => {
      this.off(event, listener);
    };
  }

  off<K extends CalloraEventName>(event: K, listener: CalloraEventListener<K>): void {
    this.listeners[event].delete(listener);
  }

  emit<K extends CalloraEventName>(event: K, developerId: string, data: CalloraEventPayloadMap[K]): boolean {
    const listeners = [...this.listeners[event]];

    for (const listener of listeners) {
      void Promise.resolve(listener(developerId, data)).catch((error) => {
        logger.error(`Unhandled error while processing ${event} listener`, error);
      });
    }

    return listeners.length > 0;
  }

  listenerCount<K extends CalloraEventName>(event: K): number {
    return this.listeners[event].size;
  }

  removeAllListeners<K extends CalloraEventName>(event?: K): void {
    if (event) {
      this.listeners[event].clear();
      return;
    }

    for (const listeners of Object.values(this.listeners)) {
      listeners.clear();
    }
  }
}

export const calloraEvents = new TypedCalloraEventEmitter();

calloraEvents.on('new_api_call', (developerId, data) => {
  return handleEvent('new_api_call', developerId, data);
});

calloraEvents.on('settlement_completed', (developerId, data) => {
  return handleEvent('settlement_completed', developerId, data);
});

calloraEvents.on('low_balance_alert', (developerId, data) => {
  return handleEvent('low_balance_alert', developerId, data);
});
