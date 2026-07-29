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
    expect(content).toContain('Register a webhook for API and balance events');
    expect(content).toContain('Successfully registered');
    expect(content).toContain('Webhook config');
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

  test('documents POST /api/webhooks/deliver/{developerId} endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/webhooks/deliver/{developerId}');
    expect(content).toContain('Deliver a webhook event');
    expect(content).toContain('Webhook delivery accepted.');
  });

  test('includes error response examples for webhook endpoints', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    // POST /api/webhooks 400 errors
    expect(content).toContain('Missing required fields');
    expect(content).toContain('Invalid event types');
    expect(content).toContain('Invalid webhook URL');
    expect(content).toContain('Invalid retry policy');
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
