/**
 * Global Jest setup for test isolation and deterministic execution
 * 
 * This file ensures proper cleanup of shared state between tests
 * to enable parallel test execution without flakiness.
 */

// Set required environment variables for validation in src/config/env.ts
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || 'test-metrics-key';

import { WebhookStore } from './src/webhooks/webhook.store.js';
import { resetAllMetrics } from './src/metrics.js';

// Clean up webhook store after each test
afterEach(() => {
  WebhookStore.clear();
});

// Reset Prometheus metrics after each test to prevent cross-test pollution
afterEach(() => {
  resetAllMetrics();
});

// Ensure environment variables are properly isolated
const originalEnv = { ...process.env };

afterEach(() => {
  // Restore original environment variables
  // Only restore keys that were originally present
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  });
  Object.keys(originalEnv).forEach((key) => {
    process.env[key] = originalEnv[key];
  });
});

// Ensure all async operations complete before moving to next test
afterEach(async () => {
  // Allow pending promises to resolve
  await new Promise((resolve) => setImmediate(resolve));
});
