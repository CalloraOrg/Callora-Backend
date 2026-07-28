import type { WebhookEventType } from '../webhooks/webhook.types.js';

export interface WebhookEventEntry {
  event: WebhookEventType;
  description: string;
  trigger: string;
  since: string;
}

const catalog: WebhookEventEntry[] = [
  {
    event: 'new_api_call',
    description: 'A developer\'s API is called and usage is recorded.',
    trigger: 'After request processing and usage event persistence.',
    since: '0.0.1',
  },
  {
    event: 'settlement_completed',
    description: 'A USDC revenue settlement completes successfully.',
    trigger: 'After settlement status and usage events are committed to the database.',
    since: '0.0.1',
  },
  {
    event: 'low_balance_alert',
    description: 'Developer balance drops below the configured threshold.',
    trigger: 'During balance check after a request, when balance < threshold.',
    since: '0.0.1',
  },
  {
    event: 'invoice_created',
    description: 'A new invoice is generated for a developer.',
    trigger: 'After invoice generation completes.',
    since: '0.0.1',
  },
  {
    event: 'quota.threshold.reached',
    description: 'A developer crosses 80%, 95%, or 100% of their monthly call quota.',
    trigger: 'After a request that pushes usage past a threshold percentage.',
    since: '0.0.1',
  },
  {
    event: 'usage.anomaly.detected',
    description: 'Abnormal traffic pattern detected for a developer.',
    trigger: 'Background anomaly detection worker identifies a spike exceeding the configured baseline multiplier.',
    since: '0.0.1',
  },
  {
    event: 'usage_event.created',
    description: 'A new usage event is recorded for a developer\'s API call.',
    trigger: 'After a usage event is successfully persisted.',
    since: '0.0.1',
  },
];

const catalogByEvent = new Map<WebhookEventType, WebhookEventEntry>(
  catalog.map((entry) => [entry.event, entry]),
);

export function getWebhookCatalog(): WebhookEventEntry[] {
  return [...catalog];
}

export function getWebhookEventEntry(event: WebhookEventType): WebhookEventEntry | undefined {
  return catalogByEvent.get(event);
}

export function isValidWebhookEvent(event: string): event is WebhookEventType {
  return catalogByEvent.has(event as WebhookEventType);
}