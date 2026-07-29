import {
  getWebhookCatalog,
  getWebhookEventEntry,
  isValidWebhookEvent,
} from './webhookCatalog.js';

describe('webhookCatalog', () => {
  describe('getWebhookCatalog', () => {
    it('returns all registered webhook events', () => {
      const catalog = getWebhookCatalog();
      expect(catalog).toHaveLength(7);
    });

    it('each entry has required fields', () => {
      const catalog = getWebhookCatalog();
      for (const entry of catalog) {
        expect(entry.event).toBeDefined();
        expect(entry.description).toBeDefined();
        expect(entry.trigger).toBeDefined();
        expect(entry.since).toBeDefined();
      }
    });

    it('includes usage_event.created', () => {
      const catalog = getWebhookCatalog();
      const usageEvent = catalog.find((e) => e.event === 'usage_event.created');
      expect(usageEvent).toBeDefined();
      expect(usageEvent!.description).toContain('usage event is recorded');
    });

    it('returns a defensive copy', () => {
      const catalog = getWebhookCatalog();
      const originalLength = catalog.length;
      catalog.pop();
      expect(getWebhookCatalog()).toHaveLength(originalLength);
    });
  });

  describe('getWebhookEventEntry', () => {
    it('returns entry for known event', () => {
      const entry = getWebhookEventEntry('new_api_call');
      expect(entry).toBeDefined();
      expect(entry!.event).toBe('new_api_call');
    });

    it('returns entry for usage_event.created', () => {
      const entry = getWebhookEventEntry('usage_event.created');
      expect(entry).toBeDefined();
      expect(entry!.event).toBe('usage_event.created');
      expect(entry!.trigger).toContain('usage event is successfully persisted');
    });

    it('returns undefined for unknown event', () => {
      const entry = getWebhookEventEntry('unknown_event' as never);
      expect(entry).toBeUndefined();
    });
  });

  describe('isValidWebhookEvent', () => {
    it('returns true for known events', () => {
      expect(isValidWebhookEvent('new_api_call')).toBe(true);
      expect(isValidWebhookEvent('usage_event.created')).toBe(true);
      expect(isValidWebhookEvent('settlement_completed')).toBe(true);
    });

    it('returns false for unknown events', () => {
      expect(isValidWebhookEvent('unknown_event')).toBe(false);
      expect(isValidWebhookEvent('')).toBe(false);
      expect(isValidWebhookEvent('usage_event.deleted')).toBe(false);
    });

    it('narrows the type for known events', () => {
      const event = 'usage_event.created';
      if (isValidWebhookEvent(event)) {
        const typed: 'usage_event.created' = event;
        expect(typed).toBe('usage_event.created');
      }
    });
  });
});