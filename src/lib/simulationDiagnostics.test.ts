import assert from 'node:assert/strict';

import {
  extractSimulationDetails,
  redactSimulationDetails,
} from './simulationDiagnostics.js';

describe('simulation diagnostics helpers', () => {
  test('extracts structured events, footprint, and error code from RPC payloads', () => {
    const details = extractSimulationDetails({
      result: {
        events: [{ type: 'diagnostic', contractAddress: 'CSECRETADDRESS', topics: ['failed'] }],
        footprint: { readOnly: ['ledger-key'], balance: '1000000' },
        error: { code: -32000, message: ' contract failed ' },
      },
    });

    assert.equal(details.errorCode, -32000);
    assert.equal(details.errorMessage, 'contract failed');
    assert.equal(details.events?.length, 1);
    assert.deepEqual(details.events?.[0], {
      type: 'diagnostic',
      contractAddress: '[REDACTED]',
      topics: ['failed'],
    });
    assert.deepEqual(details.footprint, {
      readOnly: ['ledger-key'],
      balance: '[REDACTED]',
    });
  });

  test('returns a safe summary without leaking addresses or balances', () => {
    const summary = redactSimulationDetails({
      errorCode: 'tx_failed',
      errorMessage: 'contract failed',
      events: [{ address: 'GUSER', balance: '123' }],
      footprint: { contract: 'CVAULT' },
    });

    assert.deepEqual(summary, {
      errorCode: 'tx_failed',
      errorMessage: 'contract failed',
      eventCount: 1,
      footprintPresent: true,
    });
  });

  test('handles malformed diagnostics without throwing', () => {
    assert.deepEqual(redactSimulationDetails('not-json'), {
      errorMessage: 'not-json',
      eventCount: 0,
      footprintPresent: false,
    });
  });
});
