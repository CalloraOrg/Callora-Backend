/**
 * Contract test for src/openapi.yaml.
 *
 * Validates that the /api/spike examples added for GrantFox FWC26 #911 cover
 * the timeout probe and record mutation/listing response bodies.
 */

import fs from 'node:fs';
import path from 'node:path';

describe('src/openapi.yaml - spike examples', () => {
  const yamlPath = path.join(process.cwd(), 'src', 'openapi.yaml');

  function readOpenApiYaml(): string {
    return fs.readFileSync(yamlPath, 'utf8');
  }

  test('documents public spike paths', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('/api/spike:');
    expect(content).toContain('/api/spike/records:');
    expect(content).toContain('/api/spike/{id}:');
  });

  test('includes timeout probe request and response examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('Run the spike timeout probe');
    expect(content).toContain('completesBeforeTimeout:');
    expect(content).toContain('exceedsDefaultTimeout:');
    expect(content).toContain('headerTimeout:');
    expect(content).toContain('Spike completed successfully');
    expect(content).toContain('GATEWAY_TIMEOUT');
    expect(content).toContain('Request timeout exceeded');
  });

  test('includes create request, success, validation, and audit-unavailable examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('createHighSeverityRecord:');
    expect(content).toContain('Checkout latency spike');
    expect(content).toContain('missingLabel:');
    expect(content).toContain('label is required and must be a non-empty string');
    expect(content).toContain('auditUnavailable:');
    expect(content).toContain('Audit service temporarily unavailable');
  });

  test('includes list, update, delete, and not-found examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('withRecords:');
    expect(content).toContain('records: []');
    expect(content).toContain('updateSeverity:');
    expect(content).toContain('Checkout latency spike escalated');
    expect(content).toContain('Spike record 999 not found');
    expect(content).toContain('Spike record deleted');
  });

  test('defines spike schemas and severity enum', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('SpikeRunResponse');
    expect(content).toContain('SpikeRecord');
    expect(content).toContain('SpikeRecordsResponse');
    expect(content).toContain('SpikeCreateRequest');
    expect(content).toContain('SpikeUpdateRequest');
    expect(content).toContain('enum: [low, medium, high, critical]');
  });
});
