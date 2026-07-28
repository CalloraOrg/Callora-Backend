/**
 * Unit tests for per-subscription retry policy serialisation helpers.
 *
 * These helpers live in subscriptionRepository.ts and are responsible for
 * converting RetryPolicy objects to/from the JSON text stored in SQLite.
 *
 * The DB layer (drizzle + better-sqlite3) is mocked so these pure-function
 * tests run without native binaries.
 */

// Mock the DB module so better-sqlite3 (native binary) is never loaded.
jest.mock('../db/index.js', () => ({
  db: {},
  schema: { subscriptions: {} },
}));

import { deserialiseRetryPolicy } from './subscriptionRepository.js';

describe('deserialiseRetryPolicy', () => {
  it('returns null for null input', () => {
    expect(deserialiseRetryPolicy(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(deserialiseRetryPolicy(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(deserialiseRetryPolicy('')).toBeNull();
  });

  it('parses a fully-specified policy', () => {
    const json = JSON.stringify({ maxRetries: 5, baseDelayMs: 2000 });
    expect(deserialiseRetryPolicy(json)).toEqual({ maxRetries: 5, baseDelayMs: 2000 });
  });

  it('parses a policy with only maxRetries', () => {
    const json = JSON.stringify({ maxRetries: 3 });
    expect(deserialiseRetryPolicy(json)).toEqual({ maxRetries: 3 });
  });

  it('parses a policy with only baseDelayMs', () => {
    const json = JSON.stringify({ baseDelayMs: 500 });
    expect(deserialiseRetryPolicy(json)).toEqual({ baseDelayMs: 500 });
  });

  it('parses a policy with maxRetries: 0', () => {
    const json = JSON.stringify({ maxRetries: 0 });
    expect(deserialiseRetryPolicy(json)).toEqual({ maxRetries: 0 });
  });

  it('returns null for malformed JSON (does not throw)', () => {
    expect(deserialiseRetryPolicy('not-json')).toBeNull();
    expect(deserialiseRetryPolicy('{bad json')).toBeNull();
    expect(deserialiseRetryPolicy('{"unclosed":')).toBeNull();
  });

  it('parses an empty object {} as a valid (no-override) policy', () => {
    const json = JSON.stringify({});
    expect(deserialiseRetryPolicy(json)).toEqual({});
  });
});
