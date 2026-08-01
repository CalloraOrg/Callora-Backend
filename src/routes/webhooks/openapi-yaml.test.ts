import fs from 'node:fs';
import path from 'node:path';

describe('src/openapi.yaml — webhooks examples', () => {
  const yamlPath = path.join(process.cwd(), 'src', 'openapi.yaml');

  test('documents GET /api/webhooks/{developerId} endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks/{developerId}');
    expect(content).toContain('Get webhook config');
  });

  test('documents POST /api/webhooks endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks');
    expect(content).toContain('Register a webhook');
  });

  test('includes register and get response examples for webhooks', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('Register with all optional fields');
    expect(content).toContain('Webhook registered successfully.');
    expect(content).toContain('Webhook configuration with retry policy');
    expect(content).toContain('No webhook registered');
    expect(content).toContain('new_api_call');
    expect(content).toContain('low_balance_alert');
  });

  test('documents POST /api/webhooks/{developerId}/rotate-secret endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks/{developerId}/rotate-secret');
    expect(content).toContain('Rotate webhook signing secret');
    expect(content).toContain('Webhook secret rotated successfully.');
  });

  test('documents DELETE /api/webhooks/{developerId} endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('Remove webhook');
    expect(content).toContain('Webhook removed.');
  });

  test('documents PATCH /api/webhooks/{developerId}/retry-policy endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks/{developerId}/retry-policy');
    expect(content).toContain('Update webhook retry policy');
    expect(content).toContain('Webhook retry policy updated successfully.');
  });

  test('documents POST /api/webhooks/{developerId}/delete-token endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks/{developerId}/delete-token');
    expect(content).toContain('Issue webhook deletion confirmation token');
    expect(content).toContain('WebhookDeleteTokenResponse');
  });

  test('documents POST /api/webhooks/deliver/{developerId} endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks/deliver/{developerId}');
    expect(content).toContain('Deliver a signed webhook event');
    expect(content).toContain('Webhook delivery accepted.');
  });

  test('includes error response examples for webhook endpoints', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    // POST /api/webhooks 400 errors
    expect(content).toContain('developerId, url, or events missing');
    expect(content).toContain('Event type not in the supported set');
    expect(content).toContain('URL failed reachability validation');
    expect(content).toContain('Retry policy values out of range');
    // rotate-secret 404
    expect(content).toContain('req-webhook-rotate-404');
    // retry-policy 400 and 404
    expect(content).toContain('req-webhook-retry-patch-400');
    expect(content).toContain('req-webhook-retry-patch-404');
    // deliver 400, 401, 404
    expect(content).toContain('req-webhook-deliver-400-sig');
    expect(content).toContain('req-webhook-deliver-401-invalid');
    expect(content).toContain('req-webhook-deliver-404');
  });
});
