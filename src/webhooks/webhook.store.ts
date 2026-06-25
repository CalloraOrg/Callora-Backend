import { WebhookConfig, WebhookEventType, DeadLetterEntry } from './webhook.types.js';

const store = new Map<string, WebhookConfig>();
const deadLetterStore = new Map<string, DeadLetterEntry>();

function normalizeConfig(config: WebhookConfig): WebhookConfig {
    const secret_current = config.secret_current ?? config.secret;

    return {
        ...config,
        secret: secret_current,
        secret_current,
    };
}

export const WebhookStore = {
    register(config: WebhookConfig): void {
        store.set(config.developerId, normalizeConfig(config));
    },

    get(developerId: string): WebhookConfig | undefined {
        return store.get(developerId);
    },

    rotateSecret(
        developerId: string,
        newSecret: string,
        previousExpiresAt: Date,
    ): WebhookConfig | undefined {
        const currentConfig = store.get(developerId);
        if (!currentConfig) return undefined;

        const currentSecret = currentConfig.secret_current ?? currentConfig.secret;
        const nextConfig = normalizeConfig({
            ...currentConfig,
            secret: newSecret,
            secret_current: newSecret,
            secret_previous: currentSecret,
            previous_expires_at: currentSecret ? previousExpiresAt : undefined,
        });

        store.set(developerId, nextConfig);
        return nextConfig;
    },

    getActiveSecrets(config: WebhookConfig, now: Date = new Date()): string[] {
        const secrets = new Set<string>();
        const currentSecret = config.secret_current ?? config.secret;

        if (currentSecret) {
            secrets.add(currentSecret);
        }

        if (
            config.secret_previous &&
            config.previous_expires_at &&
            config.previous_expires_at.getTime() >= now.getTime()
        ) {
            secrets.add(config.secret_previous);
        }

        return [...secrets];
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

    /** Clear all webhook configurations - for testing only */
    clear(): void {
        store.clear();
    },
};
