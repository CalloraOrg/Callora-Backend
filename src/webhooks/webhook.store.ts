import { WebhookConfig, WebhookEventType } from './webhook.types';

const store = new Map<string, WebhookConfig>();

export const WebhookStore = {
    register(config: WebhookConfig): void {
        store.set(config.developerId, config);
    },

    get(developerId: string): WebhookConfig | undefined {
        return store.get(developerId);
    },

    delete(developerId: string): void {
        store.delete(developerId);
    },

    getByEvent(event: WebhookEventType): WebhookConfig[] {
        return [...store.values()].filter((cfg) => cfg.events.includes(event));
    },

    list(): WebhookConfig[] {
        return [...store.values()];
    },
};