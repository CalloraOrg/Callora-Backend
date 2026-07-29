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
});
